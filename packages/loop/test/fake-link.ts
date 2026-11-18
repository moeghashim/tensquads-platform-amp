import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Brief, InboxAnswer, ResultAnswer, SignalDelivery, StartAnswer, TaskResult } from "@tensquads/contracts";
import type { ModelAnswer } from "@tensquads/core";

import type { Link, ModelCall, ModelLimit, StepCall } from "../src/link.js";

export type Script = (call: ModelCall) => ModelAnswer | ModelLimit | Promise<ModelAnswer | ModelLimit>;

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
	inboxCalls = 0;
	savedCopy: string | null = null;
	signals: SignalDelivery[] = [];
	inboxAnswer: InboxAnswer = { messages: [], forget: [], signals: [] };
	verdicts: ResultAnswer[] = [];

	constructor(private readonly script: Script) {}

	async start(): Promise<StartAnswer> {
		return { brief, taskType: "answer-question", forget: [], journal: this.savedCopy, signals: this.signals };
	}

	async model(call: ModelCall): Promise<ModelAnswer | ModelLimit> {
		this.models.push(call);
		return this.script(call);
	}

	async step(call: StepCall): Promise<void> {
		this.steps.push(call);
	}

	async inbox(): Promise<InboxAnswer> {
		this.inboxCalls += 1;
		return this.inboxAnswer;
	}

	async journal(copy: string): Promise<void> {
		this.journals.push(copy);
		this.savedCopy = copy;
	}

	async result(result: TaskResult): Promise<ResultAnswer> {
		this.results.push(result);
		return this.verdicts.shift() ?? { verdict: "stands", reason: "" };
	}
}

// A new work directory, as in a new sandbox. The test removes it at its end.
export function workDir(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "loop-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
