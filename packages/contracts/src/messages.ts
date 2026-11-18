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

export const ownerMessage = z.discriminatedUnion("type", [
	reply,
	question,
	approvalRequest,
	result,
	status,
	actionNotConfirmed,
]);

export type OwnerMessage = z.infer<typeof ownerMessage>;

export const OWNER_MESSAGE_TYPES = [
	"reply",
	"question",
	"approval_request",
	"result",
	"status",
	"action_not_confirmed",
] as const;
