import { z } from "zod";

// The brief, the result, the pass and the gateway calls (ARCHITECTURE sections 3.4, 3.5, 4.2 and 6.4).

const id = z.string().min(1);
const count = z.int().positive();

// The brief has six parts (requirement L1). Each fact is a separate part with the id of its row.
export const brief = z
	.object({
		goal: z.string().min(1),
		done: z.string().min(1),
		facts: z.array(z.object({ id, text: z.string() }).strict()),
		limits: z.object({ maxTurns: count, maxBudget: z.number().positive() }).strict(),
		notInTask: z.array(z.string()),
		replyTo: id,
	})
	.strict();

export type Brief = z.infer<typeof brief>;

// The stop names of a task (requirement L2, section 4.2).
export const STOP_NAMES = ["success", "question", "waiting", "max_turns", "max_budget", "error", "cancelled"] as const;

export const stopName = z.enum(STOP_NAMES);

export type StopName = z.infer<typeof stopName>;

// The result of a task (section 6.4). The question is there only when the stop is "question".
export const taskResult = z
	.object({
		stop: stopName,
		answer: z.string(),
		evidence: z.array(z.string()),
		proposedFacts: z.array(z.string()),
		notes: z.array(z.string()),
		question: z
			.object({ id, text: z.string().min(1) })
			.strict()
			.optional(),
	})
	.strict()
	.refine((result) => (result.stop === "question") === (result.question !== undefined), {
		message: "A result has a question only when its stop is question.",
		path: ["question"],
	});

export type TaskResult = z.infer<typeof taskResult>;

// The content of a pass (section 3.4). The Worker signs it. The end time is in milliseconds.
export const passClaims = z
	.object({
		accountId: id,
		bot: id,
		taskId: id,
		attemptNo: count,
		endsAt: z.int().positive(),
	})
	.strict();

export type PassClaims = z.infer<typeof passClaims>;

// The versions of one attempt (requirement L11).
export const attemptVersions = z
	.object({
		workerCommit: z.string(),
		runnerCommit: z.string(),
		pluginListHash: z.string(),
		botVersion: z.string(),
		provider: z.string(),
		model: z.string(),
		// The provider and the model of Petra when she started the attempt (task 12). An attempt of a version before
		// task 12 has none.
		petraProvider: z.string().optional(),
		petraModel: z.string().optional(),
	})
	.strict();

export type AttemptVersions = z.infer<typeof attemptVersions>;

// A decision of the owner that the runner delivers as a signal (section 4.4).
export const signalDelivery = z.object({ key: id, value: z.unknown() }).strict();

export type SignalDelivery = z.infer<typeof signalDelivery>;

// A message for a task that runs (requirement L3). The source reference is the request id in the loop.
export const inboxMessage = z.object({ sourceRef: id, text: z.string().min(1) }).strict();

export type InboxMessage = z.infer<typeof inboxMessage>;

// One file of the draft store, with its body as base64 text.
export const draftFile = z.object({ path: id, body: z.string() }).strict();

export type DraftFile = z.infer<typeof draftFile>;

// Each call has the call number and the runner id. The pass is in the header "authorization".
const callBase = { callNo: count, runnerId: id };

const modelMessage = z.object({ role: z.enum(["system", "user", "assistant", "tool"]), content: z.string() }).strict();

export const gatewayCall = z.discriminatedUnion("call", [
	z
		.object({
			...callBase,
			call: z.literal("start"),
			runnerCommit: z.string(),
			pluginListHash: z.string(),
		})
		.strict(),
	z
		.object({
			...callBase,
			call: z.literal("model"),
			turnNo: count,
			messages: z.array(modelMessage),
			tools: z.array(z.string()),
		})
		.strict(),
	z
		.object({
			...callBase,
			call: z.literal("step"),
			turnNo: count,
			toolCallId: id,
			tool: id,
			summary: z.string(),
		})
		.strict(),
	z.object({ ...callBase, call: z.literal("inbox") }).strict(),
	// The body of the copy is base64 text. A copy is about 150 KB (task 01).
	z.object({ ...callBase, call: z.literal("journal"), copy: z.string().min(1) }).strict(),
	z.object({ ...callBase, call: z.literal("result"), result: taskResult }).strict(),
	// An action tool is one call to `action` (requirement G1). The id of the action is the task id and the tool-call id (G5).
	z
		.object({
			...callBase,
			call: z.literal("action"),
			toolCallId: id,
			tool: id,
			content: z.record(z.string(), z.unknown()),
		})
		.strict(),
	// A changed file goes to the draft store (requirement G11). The body is base64 text.
	z.object({ ...callBase, call: z.literal("draft"), path: id, body: z.string() }).strict(),
]);

export type GatewayCall = z.infer<typeof gatewayCall>;
export type GatewayCallName = GatewayCall["call"];

// The answers. "refused" ends the runner. "busy" means: send the same call again.
export const startAnswer = z
	.object({
		brief,
		taskType: id,
		forget: z.array(id),
		// The newest copy of the journal, as base64 text, or null for a first attempt.
		journal: z.string().nullable(),
		signals: z.array(signalDelivery),
		// The draft files that belong to the journal copy. A new attempt loads them first (G11).
		drafts: z.array(draftFile),
	})
	.strict();

export type StartAnswer = z.infer<typeof startAnswer>;

export const modelAnswer = z
	.object({
		text: z.string(),
		toolCalls: z.array(z.object({ id, name: id, input: z.unknown() }).strict()),
		requestId: id,
		provider: z.string(),
		model: z.string(),
		usage: z.object({ inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative() }).strict(),
	})
	.strict();

export const inboxAnswer = z
	.object({ messages: z.array(inboxMessage), forget: z.array(id), signals: z.array(signalDelivery) })
	.strict();

export type InboxAnswer = z.infer<typeof inboxAnswer>;

// The answer of `result`: the result stands, or the loop continues with the reason.
export const resultAnswer = z.object({ verdict: z.enum(["stands", "continue"]), reason: z.string() }).strict();

export type ResultAnswer = z.infer<typeof resultAnswer>;

// The limit of turns stops the model call with this answer (requirement L4).
export const limitAnswer = z.object({ limit: z.enum(["max_turns", "max_budget"]) }).strict();

export const gatewayRefusal = z.object({ refused: z.enum(["pass", "runner", "attempt", "task"]) }).strict();

export const gatewayBusy = z.object({ busy: z.literal(true) }).strict();

export const gatewayOk = z.object({ ok: z.literal(true) }).strict();

// The report of the launcher when a runner exits (section 3.6).
export const exitReport = z.object({ accountId: id, taskId: id, attemptNo: count, exitCode: z.int() }).strict();

export type ExitReport = z.infer<typeof exitReport>;

// The answer of `action` (section 4.4). "wait" means: park on a signal whose key is the id of the action.
export const actionAnswer = z.discriminatedUnion("status", [
	z.object({ status: z.literal("done"), answer: z.unknown() }).strict(),
	z.object({ status: z.literal("refused"), reason: z.string().min(1) }).strict(),
	z.object({ status: z.literal("wait") }).strict(),
]);

export type ActionAnswer = z.infer<typeof actionAnswer>;
