import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { testBot } from "@tensquads/bots";
import type {
	ActionAnswer,
	Brief,
	DraftFile,
	InboxAnswer,
	ResultAnswer,
	SignalDelivery,
	StartAnswer,
	TaskResult,
} from "@tensquads/contracts";
import type { ModelAnswer, System } from "@tensquads/core";

import type { ActionCall, Link, ModelCall, ModelLimit, StepCall } from "../src/link.js";
import type { RunTaskOptions } from "../src/run-task.js";

export type Script = (call: ModelCall) => ModelAnswer | ModelLimit | Promise<ModelAnswer | ModelLimit>;

// The gate of the fake link. It gets each action call and gives the answer.
export type Gate = (call: ActionCall) => ActionAnswer | Promise<ActionAnswer>;

// The name of each call, in sequence. A test reads the order of the calls from it.
export type CallName = "start" | "model" | "step" | "inbox" | "journal" | "result" | "action" | "draft";

const brief: Brief = {
	goal: "Answer the question of the customer.",
	done: "The customer has an answer.",
	facts: [{ id: "fact-1", text: "The shop opens at 9." }],
	limits: { maxTurns: 10, maxBudget: 0.5 },
	notInTask: ["Refunds."],
	replyTo: "owner-1",
};

export function text(value: string): ModelAnswer {
	return { text: value, toolCalls: [], provider: "fake", model: "fake", usage: { inputTokens: 1, outputTokens: 1 } };
}

export function toolCall(id: string, name: string, input: Record<string, unknown> = {}): ModelAnswer {
	return {
		text: "",
		toolCalls: [{ id, name, input }],
		provider: "fake",
		model: "fake",
		usage: { inputTokens: 1, outputTokens: 1 },
	};
}

// The text of the tool messages in a model call.
export function toolMessages(
	call: ModelCall,
): { toolCallId: string; tool: string; output: string; isError: boolean }[] {
	return call.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
}

// A gateway in memory. It keeps each call, and the last copy of the journal.
export class FakeLink implements Link {
	readonly models: ModelCall[] = [];
	readonly steps: StepCall[] = [];
	readonly journals: string[] = [];
	readonly results: TaskResult[] = [];
	readonly actions: ActionCall[] = [];
	readonly drafts: DraftFile[] = [];
	readonly calls: CallName[] = [];
	inboxCalls = 0;
	savedCopy: string | null = null;
	// The draft files that belong to the saved copy, as the gateway gives them with start.
	savedDrafts: DraftFile[] = [];
	signals: SignalDelivery[] = [];
	inboxAnswer: InboxAnswer = { messages: [], forget: [], signals: [] };
	verdicts: ResultAnswer[] = [];
	gate: Gate = () => ({ status: "done", answer: "sent" });
	// A journal call with this number throws, as when the sandbox stops before the copy arrives.
	failJournalAt: number | undefined;
	// The newest file of each path in the draft store.
	private readonly store = new Map<string, string>();

	constructor(private readonly script: Script) {}

	async start(): Promise<StartAnswer> {
		this.calls.push("start");
		return {
			brief,
			taskType: "answer-question",
			forget: [],
			journal: this.savedCopy,
			signals: this.signals,
			drafts: this.savedDrafts,
		};
	}

	async model(call: ModelCall): Promise<ModelAnswer | ModelLimit> {
		this.calls.push("model");
		this.models.push(call);
		return this.script(call);
	}

	async step(call: StepCall): Promise<void> {
		this.calls.push("step");
		this.steps.push(call);
	}

	async inbox(): Promise<InboxAnswer> {
		this.calls.push("inbox");
		this.inboxCalls += 1;
		return this.inboxAnswer;
	}

	async journal(copy: string): Promise<void> {
		this.calls.push("journal");
		if (this.journals.length + 1 === this.failJournalAt) {
			this.journals.push("");
			throw new Error("The sandbox stopped.");
		}
		this.journals.push(copy);
		this.savedCopy = copy;
		// The drafts that belong to a copy are the newest files that are not newer than the copy.
		this.savedDrafts = [...this.store].map(([path, body]) => ({ path, body }));
	}

	async result(result: TaskResult): Promise<ResultAnswer> {
		this.calls.push("result");
		this.results.push(result);
		return this.verdicts.shift() ?? { verdict: "stands", reason: "" };
	}

	async action(call: ActionCall): Promise<ActionAnswer> {
		this.calls.push("action");
		this.actions.push(call);
		return this.gate(call);
	}

	async draft(path: string, body: string): Promise<void> {
		this.calls.push("draft");
		this.drafts.push({ path, body });
		this.store.set(path, body);
	}
}

// A new work directory, as in a new sandbox. The test removes it at its end.
export function workDir(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "loop-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

// The options of one attempt of the test bot. The tool read_file gives a fixed text.
export function taskOptions(
	link: FakeLink,
	dir: string,
	system: System,
	tools: RunTaskOptions["tools"] = {},
): RunTaskOptions {
	return {
		bot: testBot,
		taskType: "answer-question",
		taskId: "task-1",
		attemptNo: 1,
		tools: { read_file: async (input) => `content of ${String(input.path)}`, ...tools },
		link,
		system,
		workDir: dir,
	};
}
