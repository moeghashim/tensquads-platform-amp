import { z } from "zod";

// The messages to the owner (ARCHITECTURE section 6.3).
// Each message is typed data (requirement O1).
// No message has a field for layout, colour or a component name (requirement O2).

const id = z.string().min(1);

// Each message has its sequence number in the account, and its time.
const base = {
	seq: z.int().positive(),
	at: z.iso.datetime(),
};

const reply = z
	.object({
		...base,
		type: z.literal("reply"),
		text: z.string().min(1),
	})
	.strict();

// A question for a fact has no options.
const question = z
	.object({
		...base,
		type: z.literal("question"),
		questionId: id,
		text: z.string().min(1),
		options: z.array(z.string().min(1)),
	})
	.strict();

// The rule is the id of the rule that needs the approval.
// It is null when the kind of the action needs an approval with no rule.
// The limit is in millionths of a US dollar. It is null when the rule has no amount.
// The amount of the action is in millionths of a US dollar. It is null when the action has no amount (task 12).
// The bot and the task are the task of the action.
// A later task decides the form of the content. Here it is the text that the owner reads.
const approvalRequest = z
	.object({
		...base,
		type: z.literal("approval_request"),
		approvalId: id,
		action: id,
		content: z.string().min(1),
		contentHash: id,
		rule: id.nullable(),
		limit: z.int().nonnegative().nullable(),
		amount: z.int().nonnegative().nullable(),
		bot: id,
		taskId: id,
	})
	.strict();

const result = z
	.object({
		...base,
		type: z.literal("result"),
		taskId: id,
		summary: z.string().min(1),
		evidence: z.array(z.string().min(1)),
	})
	.strict();

const status = z
	.object({
		...base,
		type: z.literal("status"),
		taskId: id,
		bot: id,
		attempt: z.int().positive(),
		step: z.string().min(1),
		since: z.iso.datetime(),
	})
	.strict();

const actionNotConfirmed = z
	.object({
		...base,
		type: z.literal("action_not_confirmed"),
		taskId: id,
		actionId: id,
		what: z.string().min(1),
	})
	.strict();

// Petra handled a decision of the owner on an approval (task 12). A screen removes the buttons of the approval.
const approvalDecided = z
	.object({
		...base,
		type: z.literal("approval_decided"),
		approvalId: id,
		decision: z.enum(["approve", "reject"]),
	})
	.strict();

// Petra handled an answer of the owner to a question (task 12).
const questionAnswered = z
	.object({
		...base,
		type: z.literal("question_answered"),
		questionId: id,
	})
	.strict();

export const ownerMessage = z.discriminatedUnion("type", [
	reply,
	question,
	approvalRequest,
	result,
	status,
	actionNotConfirmed,
	approvalDecided,
	questionAnswered,
]);

export type OwnerMessage = z.infer<typeof ownerMessage>;

export const OWNER_MESSAGE_TYPES = [
	"reply",
	"question",
	"approval_request",
	"result",
	"status",
	"action_not_confirmed",
	"approval_decided",
	"question_answered",
] as const;
