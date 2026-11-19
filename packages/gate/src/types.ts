// The rows and the ports of the gate (docs/ARCHITECTURE.md, sections 4.4 and 7.2).
// Petra gives each port. The task writer and the action writer of packages/petra have these shapes.
import type { BotDefinition, OwnerMessage } from "@tensquads/contracts";
import type { Channel, Payment, Queue } from "@tensquads/core";

export type ActionKind = "money" | "public" | "other";

// The status sequence of section 4.4.
export type ActionStatus = "pending" | "rejected" | "refused" | "started" | "done" | "not_confirmed";

export interface ActionRow {
	taskId: string;
	toolCallId: string;
	attemptNo: number;
	tool: string;
	kind: ActionKind;
	content: Record<string, unknown>;
	contentHash: string;
	status: ActionStatus;
	answer: unknown;
	// The time of "started", or null.
	startedAt: string | null;
}

export type NewAction = Omit<ActionRow, "answer">;

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalRow {
	taskId: string;
	toolCallId: string;
	contentHash: string;
	status: ApprovalStatus;
	// The id of the rule that needs the approval, or null when the kind always needs one.
	ruleId: string | null;
	// The limit of the rule at the time of the request, in millionths of a US dollar, or null.
	limit: number | null;
}

export interface RuleRow {
	ruleId: string;
	kind: string;
	params: Record<string, unknown>;
}

export interface GateStore {
	action(taskId: string, toolCallId: string): Promise<ActionRow | undefined>;
	// The id of an action is "{taskId}/{toolCallId}".
	actionById(actionId: string): Promise<ActionRow | undefined>;
	// Returns true when this call wrote the row. A row that is there does not change.
	addAction(row: NewAction): Promise<boolean>;
	// Changes the status only if the status is one of "from". Returns true when the row changed.
	moveAction(change: {
		taskId: string;
		toolCallId: string;
		from: readonly ActionStatus[];
		to: ActionStatus;
		answer?: unknown;
		at: string;
	}): Promise<boolean>;
	// The newest active rule of the kind.
	activeRule(kind: string): Promise<RuleRow | undefined>;
	approval(taskId: string, toolCallId: string, contentHash: string): Promise<ApprovalRow | undefined>;
	// A row that is there does not change.
	addApproval(row: Omit<ApprovalRow, "status"> & { at: string }): Promise<void>;
}

export interface GateTasks {
	task(taskId: string): Promise<{ bot: string; status: string; brief: { replyTo: string } } | undefined>;
	setTaskStatus(change: { taskId: string; status: "waiting for the owner"; at: string }): Promise<void>;
	addTrail(row: {
		sourceRef: string;
		taskId: string;
		attemptNo: number;
		turnNo: number | null;
		kind: "refusal" | "action";
		actor: string;
		summary: string;
		data?: unknown;
		at: string;
	}): Promise<void>;
}

type Body<T extends OwnerMessage["type"]> = Omit<Extract<OwnerMessage, { type: T }>, "seq" | "at">;

// The message writer of Petra. It writes each message one time, by its source reference.
export type Tell = (message: {
	sourceRef: string;
	channel: string;
	taskId: string;
	body: Body<"approval_request"> | Body<"action_not_confirmed">;
}) => Promise<void>;

export interface GateDeps {
	accountId: string;
	store: GateStore;
	tasks: GateTasks;
	payment: Payment;
	channel: Channel;
	tell: Tell;
	// The "check action" job goes to the "jobs" queue.
	queue: Queue;
	// The time limit of a tool (section 10).
	toolLimitMs: number;
	now: () => string;
	// The definitions of the bots. The kind of each action comes from them. The default is the test bot.
	bots?: readonly BotDefinition[];
	// The decision points of a money_limit rule with reasons (task 09). True only for three sure "yes" answers
	// about the message of the customer of the task. With no function, such a rule always needs an approval.
	reasons?: (action: { taskId: string; toolCallId: string; reasons: string }) => Promise<boolean>;
}

// One call of an action tool, from the gateway call "action".
export interface ActionRequest {
	taskId: string;
	attemptNo: number;
	// The number of the gateway call "action".
	callNo: number;
	bot: string;
	toolCallId: string;
	tool: string;
	content: Record<string, unknown>;
}
