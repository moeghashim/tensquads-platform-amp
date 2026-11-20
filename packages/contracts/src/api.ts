import { z } from "zod";
import { ownerMessage } from "./messages.js";

// The calls and answers of the Platform Worker (ARCHITECTURE section 6.5).

const id = z.string().min(1);

// The answer to POST /v1/commands and to POST /v1/admin/commands (requirement W2).
export const acceptedAnswer = z
	.object({
		status: z.literal("accepted"),
		commandId: id,
	})
	.strict();

export type AcceptedAnswer = z.infer<typeof acceptedAnswer>;

// The query of GET /v1/messages. The value comes as text, so the schema makes it a number.
export const messageListQuery = z
	.object({
		after: z.coerce.number().int().nonnegative(),
	})
	.strict();

export type MessageListQuery = z.infer<typeof messageListQuery>;

export const messageListAnswer = z
	.object({
		messages: z.array(ownerMessage),
	})
	.strict();

export type MessageListAnswer = z.infer<typeof messageListAnswer>;

// What a task does now, from its trail rows (requirement L7). A task with no trail row has no activity.
const taskActivity = z
	.object({
		taskId: id,
		bot: id,
		attemptNo: z.int().positive(),
		turnNo: z.int().positive().nullable(),
		toolCall: z.object({ id, tool: id }).strict().nullable(),
		firstAt: z.iso.datetime(),
		lastAt: z.iso.datetime(),
		sinceFirstMs: z.number(),
		sinceLastMs: z.number(),
	})
	.strict();

// The values of tasks.status (ARCHITECTURE section 7.2).
export const taskStatusAnswer = z
	.object({
		taskId: id,
		status: z.enum(["starting", "running", "waiting for the owner", "done", "failed", "cancelled"]),
		activity: taskActivity.optional(),
	})
	.strict();

export type TaskStatusAnswer = z.infer<typeof taskStatusAnswer>;

// The internal steps of Petra for one command of the account: GET /v1/commands/{commandId}/steps.
// A step has names, times, counts and amounts. It has no text of a message and no key.
const modelStep = z
	.object({
		kind: z.literal("model"),
		at: z.iso.datetime(),
		provider: z.string(),
		model: z.string(),
		ms: z.int().nonnegative(),
		inputTokens: z.int().nonnegative(),
		outputTokens: z.int().nonnegative(),
		// The tools that the model chose. An empty list: the model answered with a text only.
		tools: z.array(id),
		failed: z.boolean(),
	})
	.strict();

const toolStep = z
	.object({
		kind: z.literal("tool"),
		at: z.iso.datetime(),
		tool: id,
		ms: z.int().nonnegative(),
		failed: z.boolean(),
	})
	.strict();

// One row of the table decisions for the command (section 4.7). It has no text of the message (requirement Q3).
const decisionStep = z
	.object({
		kind: z.literal("decision"),
		at: z.iso.datetime(),
		point: id,
		decider: id,
		options: z.array(z.string()),
		answer: z.string().nullable(),
		probability: z.number().min(0).max(1).nullable(),
		used: z.boolean(),
		shadow: z.boolean(),
		ms: z.int().nonnegative().nullable(),
	})
	.strict();

// One row of the table costs for the command (section 7.1). The amount is in millionths of a US dollar.
const costStep = z
	.object({
		kind: z.literal("cost"),
		at: z.iso.datetime(),
		costKind: id,
		provider: z.string(),
		model: z.string(),
		units: z.int(),
		unit: id,
		amount: z.int(),
	})
	.strict();

const commandStep = z.discriminatedUnion("kind", [modelStep, toolStep, decisionStep, costStep]);

export type CommandStep = z.infer<typeof commandStep>;

export const commandStepsAnswer = z
	.object({
		commandId: id,
		// In the sequence of their times.
		steps: z.array(commandStep),
	})
	.strict();

export type CommandStepsAnswer = z.infer<typeof commandStepsAnswer>;

// "unauthorized" has no detail.
// "not_available" is for a command that a later task handles.
// "conflict" is for the same command id with a different content.
export const ERROR_CODES = [
	"unauthorized",
	"forbidden",
	"not_found",
	"invalid_request",
	"not_available",
	"conflict",
	"internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// Each error has one form (requirement W4).
// It has no other key, so it cannot carry a stack trace.
export const apiError = z
	.object({
		code: z.enum(ERROR_CODES),
		message: z.string().min(1),
	})
	.strict();

export type ApiError = z.infer<typeof apiError>;

// The views of the schema admin (ARCHITECTURE section 7.6). GET /v1/admin/views/{name} gives one of them.
export const ADMIN_VIEWS = ["account", "task_type", "bot", "model", "decision_point", "usage", "operations"] as const;

export type AdminView = (typeof ADMIN_VIEWS)[number];
