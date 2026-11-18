import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	defineSignal,
	defineTool,
	GenerationTask,
	Harness,
	type HarnessSettings,
	type HookRegistration,
	hook,
	type SettledSubmissionRecord,
	type Submission,
	type ToolExecutionResult,
	type ToolRegistration,
	ToolTask,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj, str, unknown } from "@earendil-works/pi-schema";
import type { BotDefinition, SignalDelivery, StopName, TaskResult } from "@tensquads/contracts";
import type { ModelAnswer, System } from "@tensquads/core";

import { answerText, type CompleteRequest, GATEWAY_MODEL, gatewayModels } from "./gateway-model.js";
import { journalCopy, writeJournal } from "./journal.js";
import { isModelLimit, type Link, RefusedError } from "./link.js";
import { removeTexts, renderBrief } from "./messages.js";

const context = BACKGROUND_CONTEXT;

// The tool "ask a question". It parks until the answer arrives as a signal (requirement L6).
export const QUESTION_TOOL = "ask_question";

// The signal kind of a decision of the owner. The key is the id of the question or of the action.
export const ANSWER_SIGNAL = defineSignal({ name: "tensquads.answer", version: 1, schema: unknown() });

// The request id of the brief. A second submit of the brief, after a resume, is dropped by pi-durable.
const BRIEF_REQUEST = "brief";

// The gateway sends each call again on "busy", so pi-durable does not retry a model call.
// Each inbox message that is queued goes into the next model request.
const SETTINGS: HarnessSettings = { retry: { enabled: false }, steeringMode: "all" };

// A tool that runs in the sandbox. It gets the input of the model and returns the text for the model.
export type ToolExecute = (input: Record<string, unknown>) => Promise<string>;

export interface RunTaskOptions {
	bot: BotDefinition;
	taskType: string;
	taskId: string;
	attemptNo: number;
	// The read tools and the compute tools of the bot. Action tools come in task 05.
	tools: Readonly<Record<string, ToolExecute>>;
	link: Link;
	system: System;
	// The local SQLite journal is in this directory.
	workDir: string;
}

interface Question {
	id: string;
	text: string;
}

interface LoopState {
	turnNo: number;
	limit?: "max_turns" | "max_budget";
	fatal?: unknown;
	stands?: TaskResult;
	forget: Set<string>;
	submitted: Set<string>;
}

// The stop name of a run that failed in pi-durable (ARCHITECTURE section 4.2).
function stopOfFailure(reason: string | undefined): StopName {
	return reason === "turn_limit" ? "max_turns" : "error";
}

function result(stop: StopName, answer: string, question?: Question): TaskResult {
	return { stop, answer, evidence: [], proposedFacts: [], notes: [], ...(question ? { question } : {}) };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function outputText(output: ToolExecutionResult["output"]): string {
	return (output ?? []).map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("");
}

function botTool(name: string, execute: ToolExecute): ToolRegistration {
	return defineTool({
		name,
		description: `The tool ${name} of the bot.`,
		parameters: obj({}, { open: true }),
		replay: "safe",
		async execute(args) {
			return { output: [{ type: "text", text: await execute(args as Record<string, unknown>) }] };
		},
	});
}

const questionTool = defineTool({
	name: QUESTION_TOOL,
	description: "Ask the owner a question. The answer comes back as the result of this tool.",
	parameters: obj({ text: str() }),
	replay: "safe",
	async execute(_args, api, ctx) {
		const signal = await api.readSignal(ANSWER_SIGNAL, api.callId, ctx);
		if (signal !== undefined && "value" in signal) {
			const text = typeof signal.value === "string" ? signal.value : JSON.stringify(signal.value);
			return { output: [{ type: "text", text }] };
		}
		return { sleep: { signals: [ANSWER_SIGNAL.key(api.callId)] } };
	},
});

// Counts the moments when pi-durable needs no process. A park makes one of them.
class IdleEvents {
	private count = 0;
	private waiters: ((count: number) => void)[] = [];

	fire(): void {
		this.count += 1;
		for (const resolve of this.waiters.splice(0)) {
			resolve(this.count);
		}
	}

	after(seen: number): Promise<number> {
		if (this.count > seen) {
			return Promise.resolve(this.count);
		}
		return new Promise((resolve) => this.waiters.push(resolve));
	}
}

type RunEnd = { settled: SettledSubmissionRecord } | { question: Question };

class TaskRun {
	private readonly state: LoopState = { turnNo: 0, forget: new Set(), submitted: new Set() };
	private readonly idle = new IdleEvents();
	private readonly file: string;
	private readonly allowed: Set<string>;
	private readonly facts = new Map<string, string>();
	private harness: Harness | undefined;
	private root: Conversation | undefined;

	constructor(private readonly options: RunTaskOptions) {
		this.file = join(options.workDir, "journal.sqlite");
		this.allowed = new Set([...options.bot.tools.map((tool) => tool.name), QUESTION_TOOL]);
	}

	private get info() {
		return { taskId: this.options.taskId, attemptNo: this.options.attemptNo };
	}

	private open(): { harness: Harness; root: Conversation } {
		if (this.harness === undefined || this.root === undefined) {
			throw new Error("The harness is not open.");
		}
		return { harness: this.harness, root: this.root };
	}

	async run(): Promise<TaskResult> {
		const { bot, taskType: name, link } = this.options;
		const taskType = bot.taskTypes.find((type) => type.name === name);
		if (taskType === undefined) {
			throw new Error(`The bot "${bot.id}" has no task type "${name}".`);
		}
		const start = await link.start();
		for (const fact of start.brief.facts) {
			this.facts.set(fact.id, fact.text);
		}
		for (const id of start.forget) {
			this.state.forget.add(id);
		}
		writeJournal(this.file, start.journal);
		const harness = await Harness.open(
			await openNodeSqliteStorage(this.file),
			{
				models: gatewayModels((request) => this.complete(request)),
				registry: this.registry(),
				settings: SETTINGS,
				onWake: (wake) => {
					if (!wake.active) this.idle.fire();
				},
			},
			context,
		);
		this.harness = harness;
		let end: RunEnd;
		try {
			const agent = { model: GATEWAY_MODEL, maxTurns: taskType.limits.maxTurns };
			this.root = await harness.root(context, { agent });
			this.state.turnNo = (await this.root.context(context)).messages.filter((m) => m.role === "assistant").length;
			const brief = { type: "input", content: renderBrief(start.brief), requestId: BRIEF_REQUEST } as const;
			const submission = await this.root.submit(brief, context);
			await this.deliver(start.signals);
			harness.resume();
			end = await this.waitForEnd(submission);
		} finally {
			await harness.close(context);
		}
		const outcome = await this.outcome(end);
		await this.options.system.emit("task/end", { taskId: this.options.taskId, stop: outcome.stop });
		return outcome;
	}

	private async outcome(end: RunEnd): Promise<TaskResult> {
		const { fatal, stands, limit } = this.state;
		if (fatal instanceof RefusedError) {
			throw fatal;
		}
		if (fatal !== undefined) {
			return result("error", `The loop stopped: ${errorText(fatal)}`);
		}
		if ("question" in end) {
			// The park is in the journal. The new attempt opens this copy and delivers the answer.
			await this.options.link.journal(journalCopy(this.file));
			return result("question", "", end.question);
		}
		if (stands !== undefined) {
			return stands;
		}
		if (limit !== undefined) {
			return result(limit, `The task stopped at the limit ${limit}.`);
		}
		const { reason, detail } = end.settled;
		return result(
			stopOfFailure(reason),
			`The run ended with no answer: ${reason ?? "unknown"} ${detail ?? ""}`.trim(),
		);
	}

	// Waits for the end of the run, or for a park of the tool "ask a question".
	private async waitForEnd(submission: Submission): Promise<RunEnd> {
		const settled = submission.wait(context).then((record) => ({ settled: record }));
		let seen = 0;
		for (;;) {
			const next = await Promise.race([settled, this.idle.after(seen).then((count) => ({ idle: count }))]);
			if ("settled" in next) {
				return next;
			}
			seen = next.idle;
			const question = await this.parkedQuestion();
			if (question !== undefined) {
				return { question };
			}
		}
	}

	private async sleepingKeys(): Promise<{ taskId: Parameters<Harness["signal"]>[0]; key: string }[]> {
		const inspection = await this.open().harness.inspect(context);
		return inspection.tasks.flatMap((task) =>
			task.state.kind === "sleeping" && task.record.state.status === "sleeping"
				? (task.record.state.signals ?? [])
						.filter((key) => key.signal === ANSWER_SIGNAL.name)
						.map((key) => ({ taskId: task.record.id, key: key.key }))
				: [],
		);
	}

	private async parkedQuestion(): Promise<Question | undefined> {
		const { harness, root } = this.open();
		if (harness.wake().active) {
			return undefined;
		}
		const [parked] = await this.sleepingKeys();
		if (parked === undefined) {
			return undefined;
		}
		const view = await root.context(context);
		const call = view.messages
			.flatMap((message) => (message.role === "assistant" ? message.content : []))
			.find((part) => part.type === "toolCall" && part.id === parked.key);
		const text = call?.type === "toolCall" && typeof call.arguments.text === "string" ? call.arguments.text : "";
		return { id: parked.key, text: text === "" ? "(no text)" : text };
	}

	// Delivers each decision of the owner to the tool call that sleeps on its key.
	private async deliver(signals: readonly SignalDelivery[]): Promise<void> {
		if (signals.length === 0) {
			return;
		}
		const sleeping = await this.sleepingKeys();
		for (const signal of signals) {
			const target = sleeping.find((item) => item.key === signal.key);
			if (target !== undefined) {
				await this.open().harness.signal(target.taskId, ANSWER_SIGNAL, signal.key, signal.value, context);
			}
		}
	}

	// Each completion of pi-ai comes here. The link calls the model on the gateway (requirement L10).
	private async complete(request: CompleteRequest): Promise<ModelAnswer> {
		if (this.state.fatal !== undefined) {
			throw this.state.fatal;
		}
		this.state.turnNo = request.turnNo;
		let answer: Awaited<ReturnType<Link["model"]>>;
		try {
			const tools = [...this.allowed].filter((name) => name === QUESTION_TOOL || name in this.options.tools);
			answer = await this.options.link.model({ turnNo: request.turnNo, messages: request.messages, tools });
		} catch (error) {
			this.state.fatal ??= error;
			throw error;
		}
		if (isModelLimit(answer)) {
			// The run ends with no answer and no new tool (requirement L4).
			this.state.limit = answer.limit;
			throw new Error(`The gateway stopped the task at the limit ${answer.limit}.`);
		}
		return answer;
	}

	// A hook keeps an error for the end of the run, because pi-durable reports a throw of a hook and continues.
	private async guard(work: () => Promise<void>): Promise<void> {
		try {
			await work();
		} catch (error) {
			this.state.fatal ??= error;
		}
	}

	private async takeInbox(): Promise<void> {
		const { root } = this.open();
		const inbox = await this.options.link.inbox();
		for (const id of inbox.forget) {
			this.state.forget.add(id);
		}
		await this.deliver(inbox.signals);
		for (const message of inbox.messages) {
			if (this.state.submitted.has(message.sourceRef)) continue;
			// The source reference is the request id. pi-durable drops a message that it has already.
			const draft = {
				type: "input",
				content: message.text,
				requestId: message.sourceRef,
				whenBusy: "steer",
			} as const;
			await root.submit(draft, context);
			this.state.submitted.add(message.sourceRef);
		}
	}

	private forgottenTexts(): string[] {
		return [...this.state.forget].flatMap((id) => this.facts.get(id) ?? []);
	}

	private async beforeRequest(messages: readonly Message[]): Promise<{ messages: Message[] } | undefined> {
		await this.guard(async () => {
			await this.options.system.emit("model/before", this.info);
			await this.takeInbox();
		});
		const texts = this.forgottenTexts();
		return texts.length === 0 ? undefined : { messages: removeTexts(messages, texts) };
	}

	private async onYield(text: string): Promise<{ continue: string } | undefined> {
		if (this.state.fatal !== undefined) {
			return undefined;
		}
		const { system, link, taskId } = this.options;
		try {
			const refusal = await system.ask("answer/check", { taskId, text });
			if (refusal !== undefined) {
				return { continue: refusal };
			}
			const answer = result("success", text);
			const verdict = await link.result(answer);
			if (verdict.verdict === "continue") {
				return { continue: verdict.reason };
			}
			this.state.stands = answer;
		} catch (error) {
			this.state.fatal ??= error;
		}
		return undefined;
	}

	private hooks(): HookRegistration[] {
		const { system, link, taskId } = this.options;
		return [
			hook(GenerationTask, {
				beforeRequest: (request) => this.beforeRequest(request.messages),
				afterTools: async () => {
					await this.guard(async () => {
						await link.journal(journalCopy(this.file));
						await system.emit("turn/end", this.info);
					});
					return undefined;
				},
				onYield: (answer) => this.onYield(answerText(answer)),
			}),
			hook(ToolTask, {
				beforeTool: async (call) => {
					if (!this.allowed.has(call.name)) {
						return { block: `The tool "${call.name}" is not on the list of the bot.` };
					}
					const refusal = await system.ask("tool/before", { taskId, toolCallId: call.id, tool: call.name });
					return refusal === undefined ? undefined : { block: refusal };
				},
				afterTool: async (call, toolResult) => {
					await this.guard(async () => {
						const summary = outputText(toolResult.output).slice(0, 500);
						await link.step({ turnNo: this.state.turnNo, toolCallId: call.id, tool: call.name, summary });
						await system.emit("tool/after", { taskId, toolCallId: call.id, tool: call.name });
					});
					return undefined;
				},
			}),
		];
	}

	private registry() {
		const tools: ToolRegistration[] = [
			...Object.entries(this.options.tools).map(([name, execute]) => botTool(name, execute)),
			questionTool,
		];
		const registry = createRegistry();
		registry.install(defineExtension({ name: "tools", tools }));
		registry.install(defineExtension({ name: "hooks", hooks: this.hooks() }));
		return registry;
	}
}

// Runs one attempt of a task. It returns the result with its stop name (requirement L2).
// It throws RefusedError when the gateway refuses a call. Then the runner exits.
export function runTask(options: RunTaskOptions): Promise<TaskResult> {
	return new TaskRun(options).run();
}
