import { z } from "zod";

import { period } from "./admin.js";

// The commands to Petra (ARCHITECTURE section 6.1).
// The account is never a field. It comes from the identity of the caller.

const id = z.string().min(1);

// Each command has these fields. A retry sends the same command id.
const base = {
	commandId: id,
	at: z.iso.datetime(),
};

const ownerMessageCommand = z
	.object({
		...base,
		type: z.literal("OwnerMessage"),
		messageId: id,
		channel: id,
		text: z.string().min(1),
	})
	.strict();

// The origin of an external event is always "not trusted".
// The field `type` names the command, so the type of the event is `eventType`.
const externalEvent = z
	.object({
		...base,
		type: z.literal("ExternalEvent"),
		eventId: id,
		source: id,
		eventType: id,
		sender: id,
		// A later task decides the form of the payload of each source.
		payload: z.record(z.string(), z.unknown()),
	})
	.strict();

const approvalDecision = z
	.object({
		...base,
		type: z.literal("ApprovalDecision"),
		approvalId: id,
		decision: z.enum(["approve", "reject"]),
		contentHash: id,
	})
	.strict();

const ownerAnswer = z
	.object({
		...base,
		type: z.literal("OwnerAnswer"),
		questionId: id,
		text: z.string().min(1),
	})
	.strict();

const cancelTask = z
	.object({
		...base,
		type: z.literal("CancelTask"),
		taskId: id,
	})
	.strict();

// A rule has a kind and its parameters, as in the table `rules`.
// A later task decides the kinds and the form of their parameters.
const setRule = z
	.object({
		...base,
		type: z.literal("SetRule"),
		rule: z
			.object({
				kind: id,
				params: z.record(z.string(), z.unknown()),
			})
			.strict(),
	})
	.strict();

const addCoreItem = z
	.object({
		...base,
		type: z.literal("AddCoreItem"),
		text: z.string().min(1),
	})
	.strict();

const removeCoreItem = z
	.object({
		...base,
		type: z.literal("RemoveCoreItem"),
		itemId: id,
	})
	.strict();

const forgetFact = z
	.object({
		...base,
		type: z.literal("ForgetFact"),
		factId: id,
	})
	.strict();

const undoForget = z
	.object({
		...base,
		type: z.literal("UndoForget"),
		factId: id,
	})
	.strict();

// The night job names a local date of the account.
// A check job names its target: a task or an action.
const runJob = z
	.object({
		...base,
		type: z.literal("RunJob"),
		job: z.enum(["night", "check task", "check action"]),
		localDate: z.iso.date().optional(),
		targetId: id.optional(),
	})
	.strict()
	.refine(
		(cmd) =>
			cmd.job === "night"
				? cmd.localDate !== undefined && cmd.targetId === undefined
				: cmd.targetId !== undefined && cmd.localDate === undefined,
		{
			message: "The night job needs localDate. A check job needs targetId.",
			path: ["job"],
		},
	);

// Credits are whole numbers.
const grantCredits = z
	.object({
		...base,
		type: z.literal("GrantCredits"),
		credits: z.int().positive(),
	})
	.strict();

const resendSandboxRequests = z
	.object({
		...base,
		type: z.literal("ResendSandboxRequests"),
	})
	.strict();

// The amount is in millionths of a US dollar. It can be plus or minus.
// A later task decides the form of the period.
const addCostShare = z
	.object({
		...base,
		type: z.literal("AddCostShare"),
		sharedCostId: id,
		period,
		kind: z.enum(["storage", "database", "worker"]),
		provider: id,
		amount: z.int(),
	})
	.strict();

const sandboxExited = z
	.object({
		...base,
		type: z.literal("SandboxExited"),
		taskId: id,
		attempt: z.int().positive(),
		exitCode: z.int(),
	})
	.strict();

export const command = z.discriminatedUnion("type", [
	ownerMessageCommand,
	externalEvent,
	approvalDecision,
	ownerAnswer,
	cancelTask,
	setRule,
	addCoreItem,
	removeCoreItem,
	forgetFact,
	undoForget,
	runJob,
	grantCredits,
	resendSandboxRequests,
	addCostShare,
	sandboxExited,
]);

export type Command = z.infer<typeof command>;

// The commands that an owner sends with POST /v1/commands.
export const ownerCommand = z.discriminatedUnion("type", [
	ownerMessageCommand,
	approvalDecision,
	ownerAnswer,
	cancelTask,
	setRule,
	addCoreItem,
	removeCoreItem,
	forgetFact,
	undoForget,
]);

export type OwnerCommand = z.infer<typeof ownerCommand>;
