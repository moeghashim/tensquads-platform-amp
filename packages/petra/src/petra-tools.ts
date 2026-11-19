// The tools of Petra (docs/ARCHITECTURE.md, section 4.6), and the two memory tools of the owner (task 08). The loop declares each one replay: "safe".
// Each tool writes by a key from its command, and reads its decision rows first, so a second run changes nothing.
// The input of each tool has the command id, the channel and the text of the owner message. The code puts them in
// the input from the current command, never from the answer of the model (petra-model.ts). Only the tools that answer
// or ask the owner take their text from the model.
import { testBot } from "@tensquads/bots";
import type { BotDefinition } from "@tensquads/contracts";

import type { AccountReader, AccountWriter } from "./account-writer.js";
import type { Outbox } from "./outbox.js";
import type { TaskWork } from "./task-work.js";
import type { TaskReader, TaskRow, TaskWriter } from "./task-writer.js";

// The shape of a tool of the loop package. This package does not import the loop (requirement C2).
export interface PetraToolDefinition {
	name: string;
	description: string;
	// The JSON schema of the input that the model gives. The code adds the command id, the channel and the text.
	parameters: Record<string, unknown>;
	execute(input: Record<string, unknown>): Promise<string>;
}

export const PETRA_TOOLS = {
	startTask: "start_task",
	answerOwner: "answer_owner",
	askOwner: "ask_owner",
	readMemory: "read_memory",
	taskStatus: "task_status",
	stopTask: "stop_task",
	rememberFact: "remember_fact",
	promoteFact: "promote_fact",
} as const;

// The bots that can start a task. Petra is not in the list. The decision point "which bot" chooses one.
export const TASK_BOTS: readonly BotDefinition[] = [testBot];

// The input of a tool with no field from the model.
const NO_INPUT = { type: "object", properties: {}, additionalProperties: false };

// The input of a tool that sends a text of the model to the owner.
const TEXT_INPUT = {
	type: "object",
	properties: { text: { type: "string", description: "The text for the owner, in plain text." } },
	required: ["text"],
	additionalProperties: false,
};

// The tools that only read. They do not mark the command done, so the model must answer the owner after them.
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([PETRA_TOOLS.readMemory]);

// The tools that take their text from the model. Each other tool gets the text of the owner message.
export const MODEL_TEXT_TOOLS: ReadonlySet<string> = new Set([PETRA_TOOLS.answerOwner, PETRA_TOOLS.askOwner]);

// The answer of the point "is this message for a task that runs" when the message is for no task.
const NEW_TASK = "new task";

// One question of Petra to the decider (docs/ARCHITECTURE.md, section 4.7). The decisions package answers it.
// This package does not import it (requirement C2).
export interface ToolAsk {
	sourceRef: string;
	point: "request-clear" | "which-bot" | "message-for-task";
	taskId: null;
	messageSeq: number | null;
	message: string;
	options?: readonly string[];
}

// The code uses the answer only when it is sure (requirement Q4).
export interface ToolVerdict {
	answer: string | null;
	sure: boolean;
}

export interface ToolDecisions {
	ask(asks: readonly ToolAsk[]): Promise<ToolVerdict[]>;
}

export interface PetraToolsDeps {
	writer: Pick<AccountWriter & AccountReader, "finishEvent" | "messageSeq">;
	// The decision points of Petra: one call for each step of the decision sequence (section 4.6).
	decisions: ToolDecisions;
	tasks: TaskWriter & TaskReader;
	work: TaskWork;
	outbox: Outbox;
	now: () => string;
	// The memory (packages/memory). This package does not import it (requirement C2).
	memory: ToolMemory;
}

// The part of the memory that the tools use. Each method answers the owner and returns the text of the answer.
export interface ToolMemory {
	rememberFact(fact: { commandId: string; channel: string; page: string; text: string; at: string }): Promise<string>;
	promoteFact(promote: { commandId: string; channel: string; factId: string; at: string }): Promise<string>;
}

// The owner writes a fact as "remember on <page>: <text>", and promotes a fact as "promote fact <id>".
const REMEMBER = /^remember on ([^:]+):\s*(\S[\s\S]*)$/i;
const PROMOTE = /\bpromote fact (\S+)/i;

interface ToolInput {
	commandId: string;
	channel: string;
	text: string;
}

function inputOf(input: Record<string, unknown>): ToolInput {
	const { commandId, channel, text } = input;
	if (typeof commandId !== "string" || commandId === "") throw new Error("The tool input has no command id.");
	return {
		commandId,
		channel: typeof channel === "string" && channel !== "" ? channel : "chat",
		text: typeof text === "string" ? text : "",
	};
}

// The task that the text names, or each open task when the text names none.
function targets(open: readonly TaskRow[], text: string): TaskRow[] {
	const named = open.filter((task) => text.includes(task.id));
	return named.length > 0 ? named : [...open];
}

export function petraTools(deps: PetraToolsDeps): PetraToolDefinition[] {
	const { tasks, work, outbox } = deps;

	const reply = (input: ToolInput, text: string, taskId?: string) =>
		outbox.tell({
			sourceRef: `cmd/${input.commandId}/reply`,
			channel: input.channel,
			body: { type: "reply", text },
			...(taskId ? { taskId } : {}),
		});

	// A choice of the code, as a decision row. A second run of the tool reads it and makes the same choice.
	async function decide(input: ToolInput, point: string, choose: () => Promise<string>): Promise<string> {
		const sourceRef = `cmd/${input.commandId}/${point}`;
		const earlier = await tasks.decision(sourceRef, "code");
		if (earlier !== undefined) return earlier;
		const answer = await choose();
		await tasks.addDecision({ sourceRef, decider: "code", taskId: null, point, options: [], answer, at: deps.now() });
		return (await tasks.decision(sourceRef, "code")) ?? answer;
	}

	// Petra asks the owner when the decider is not sure. The question id names the decision point, so the answer of
	// the owner can name the decision record (requirement Q6).
	async function askOwner(input: ToolInput, point: ToolAsk["point"], text: string, options: readonly string[]) {
		await outbox.tell({
			sourceRef: `cmd/${input.commandId}/question`,
			channel: input.channel,
			body: { type: "question", questionId: `${input.commandId}/${point}`, text, options: [...options] },
		});
		return `I asked the owner: ${text}`;
	}

	// The asks of one command, about the owner message of the command. The record has its seq, never its text.
	async function asksOf(input: ToolInput, points: readonly Pick<ToolAsk, "point" | "options">[]): Promise<ToolAsk[]> {
		const messageSeq = (await deps.writer.messageSeq(`cmd/${input.commandId}/in`)) ?? null;
		return points.map((point) => ({
			...point,
			sourceRef: `cmd/${input.commandId}/${point.point}`,
			taskId: null,
			messageSeq,
			message: input.text,
		}));
	}

	// The decision point "is this message for a task that runs" (section 4.6). Returns the task id, "new task", or
	// undefined when Petra asked the owner which task.
	async function route(input: ToolInput): Promise<string | undefined> {
		const running = (await tasks.openTasks()).filter((task) => task.status === "running").map((task) => task.id);
		if (running.length === 0) return NEW_TASK;
		const options = [...running, NEW_TASK];
		const [verdict] = await deps.decisions.ask(await asksOf(input, [{ point: "message-for-task", options }]));
		if (verdict?.sure && verdict.answer !== null) return verdict.answer;
		await askOwner(input, "message-for-task", "Which task is your message for?", options);
		return undefined;
	}

	// The two points before a new task, in one call: "is the request clear" and "which bot" (requirement Q2).
	async function chooseBot(input: ToolInput): Promise<BotDefinition | string> {
		const bots = TASK_BOTS.map((bot) => bot.id);
		const asks = await asksOf(input, [{ point: "request-clear" }, { point: "which-bot", options: bots }]);
		const [clear, which] = await deps.decisions.ask(asks);
		if (!clear?.sure || clear.answer !== "yes") {
			return askOwner(input, "request-clear", "Your request is not clear to me. What must the task do?", []);
		}
		const bot = which?.sure ? TASK_BOTS.find((item) => item.id === which.answer) : undefined;
		return bot ?? askOwner(input, "which-bot", "Which bot must do this task?", bots);
	}

	async function startTask(input: ToolInput): Promise<string> {
		const target = await route(input);
		if (target === undefined) return "I asked the owner which task the message is for.";
		if (target !== NEW_TASK) {
			const sourceRef = `cmd/${input.commandId}`;
			await tasks.addInbox({ taskId: target, sourceRef, kind: "message", text: input.text, at: deps.now() });
			await reply(input, `I gave your message to the task ${target}.`, target);
			return `The message went to the inbox of the task ${target}.`;
		}
		const bot = await chooseBot(input);
		if (typeof bot === "string") return bot;
		const [taskType] = bot.taskTypes;
		if (!taskType) throw new Error(`The bot "${bot.id}" has no task type.`);
		const outcome = await work.startTask({
			commandId: input.commandId,
			bot: bot.id,
			taskType: taskType.name,
			goal: input.text,
			replyTo: input.channel,
		});
		const texts = {
			started: `I started the task ${input.commandId}.`,
			"no credits": "Your credits are not sufficient for this task.",
			ended: `The task ${input.commandId} ended.`,
		} as const;
		await reply(input, texts[outcome], outcome === "no credits" ? undefined : input.commandId);
		return texts[outcome];
	}

	// The tool "stop a task" does the same as the command CancelTask (requirement L15).
	async function stopTask(input: ToolInput): Promise<string> {
		const choice = await decide(input, "stop", async () => {
			const found = targets(await tasks.openTasks(), input.text);
			if (found.length === 0) return "none";
			return found.length === 1 && found[0] ? found[0].id : JSON.stringify(found.map((task) => task.id));
		});
		if (choice === "none") {
			await reply(input, "You have no open task.");
			return "No open task.";
		}
		if (choice.startsWith("[")) {
			// Two open tasks and no clear target: Petra asks which one.
			const options = JSON.parse(choice) as string[];
			await outbox.tell({
				sourceRef: `cmd/${input.commandId}/question`,
				channel: input.channel,
				body: { type: "question", questionId: `${input.commandId}/which`, text: "Which task do I stop?", options },
			});
			return "I asked the owner which task to stop.";
		}
		await work.cancel(choice, "owner");
		return `The task ${choice} is cancelled.`;
	}

	// The status comes from the trail rows of the task (requirement L7).
	async function taskStatus(input: ToolInput): Promise<string> {
		const [task] = targets(await tasks.openTasks(), input.text).reverse();
		if (!task) {
			await reply(input, "You have no open task.");
			return "No open task.";
		}
		const activity = await tasks.taskActivity(task.id, deps.now());
		const detail = activity
			? ` It is in attempt ${activity.attemptNo}, turn ${activity.turnNo ?? 0}. The last row is from ${activity.lastAt}.`
			: "";
		const text = `The task ${task.id} is ${task.status}.${detail}`;
		await reply(input, text, task.id);
		return text;
	}

	// The system sets the origin "owner" of the fact. The answer has the id of the fact (requirement M2).
	async function rememberFact(input: ToolInput): Promise<string> {
		const match = REMEMBER.exec(input.text.trim());
		if (!match) {
			const text = "Write the fact as: remember on <page>: <text>.";
			await reply(input, text);
			return text;
		}
		const [, page = "", text = ""] = match;
		return deps.memory.rememberFact({ ...input, page: page.trim(), text: text.trim(), at: deps.now() });
	}

	// Only the owner promotes a fact to the core (requirement M3).
	async function promoteFact(input: ToolInput): Promise<string> {
		const factId = PROMOTE.exec(input.text)?.[1];
		if (!factId) {
			const text = "Write the promote as: promote fact <id>.";
			await reply(input, text);
			return text;
		}
		return deps.memory.promoteFact({ commandId: input.commandId, channel: input.channel, factId, at: deps.now() });
	}

	const tool = (name: string, description: string, run: (input: ToolInput) => Promise<string>) => ({
		name,
		description,
		parameters: MODEL_TEXT_TOOLS.has(name) ? TEXT_INPUT : NO_INPUT,
		async execute(raw: Record<string, unknown>) {
			const input = inputOf(raw);
			const output = await run(input);
			// The command is complete when its tool is complete (section 4.6).
			await deps.writer.finishEvent(input.commandId);
			return output;
		},
	});

	return [
		tool(
			PETRA_TOOLS.startTask,
			"Start a task of a bot for the message of the owner, or give the message to the task that runs. The code checks the credits.",
			startTask,
		),
		tool(PETRA_TOOLS.answerOwner, "Answer the owner with a text.", async (input) => {
			await reply(input, input.text);
			return "The answer is sent.";
		}),
		tool(PETRA_TOOLS.askOwner, "Ask the owner a question.", async (input) => {
			await outbox.tell({
				sourceRef: `cmd/${input.commandId}/question`,
				channel: input.channel,
				body: { type: "question", questionId: `${input.commandId}/ask`, text: input.text, options: [] },
			});
			return "The question is sent.";
		}),
		{
			name: PETRA_TOOLS.readMemory,
			description: "Read the memory of the account.",
			parameters: NO_INPUT,
			// The memory comes in a later task. The tool only reads, so it does not mark a command.
			execute: async () => "The memory has no facts yet.",
		},
		tool(PETRA_TOOLS.taskStatus, "Tell the status of a task.", taskStatus),
		tool(PETRA_TOOLS.stopTask, "Stop a task of the owner. The message of the owner can name the task.", stopTask),
		tool(
			PETRA_TOOLS.rememberFact,
			'Keep a fact of the owner on a page of the memory. The owner writes it as "remember on <page>: <text>".',
			rememberFact,
		),
		tool(
			PETRA_TOOLS.promoteFact,
			'Put a fact into the core of the memory. The owner writes it as "promote fact <id>".',
			promoteFact,
		),
	];
}
