import type { ActionAnswer, InboxAnswer, ResultAnswer, StartAnswer, TaskResult } from "@tensquads/contracts";
import type { ModelAnswer, ModelMessage } from "@tensquads/core";

// The link is the gateway client of a runner (ARCHITECTURE section 3.5).
// Each method is one gateway call. The HTTP version is in packages/link.

export interface ModelCall {
	turnNo: number;
	messages: ModelMessage[];
	tools: string[];
}

// The gateway stops the model call at a limit of the task type (requirement L4).
export interface ModelLimit {
	limit: "max_turns" | "max_budget";
}

export interface StepCall {
	turnNo: number;
	toolCallId: string;
	tool: string;
	summary: string;
}

// One request for an action (requirement G1). The id of the action is the task id and the tool-call id (G5).
export interface ActionCall {
	toolCallId: string;
	tool: string;
	content: Record<string, unknown>;
}

export interface Link {
	start(): Promise<StartAnswer>;
	model(call: ModelCall): Promise<ModelAnswer | ModelLimit>;
	step(call: StepCall): Promise<void>;
	inbox(): Promise<InboxAnswer>;
	// The copy of the journal is base64 text.
	journal(copy: string): Promise<void>;
	result(result: TaskResult): Promise<ResultAnswer>;
	// The gate does the action, refuses it, or tells the tool to wait for the owner (section 4.4).
	action(call: ActionCall): Promise<ActionAnswer>;
	// Saves one changed file to the draft store (requirement G11). The body is base64 text.
	draft(path: string, body: string): Promise<void>;
}

export type RefusalReason = "pass" | "runner" | "attempt" | "task";

// The gateway refused a call. The runner stops and exits.
export class RefusedError extends Error {
	override name = "RefusedError";
	readonly reason: RefusalReason;

	constructor(reason: RefusalReason, call: string) {
		super(`The gateway refused the call "${call}" (reason: ${reason}).`);
		this.reason = reason;
	}
}

export function isModelLimit(answer: ModelAnswer | ModelLimit): answer is ModelLimit {
	return "limit" in answer;
}
