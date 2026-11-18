import { z } from "zod";

// A task type has a price in credits and the limits of one task.
const taskType = z
	.object({
		name: z.string().min(1),
		price: z.int().positive(),
		limits: z
			.object({
				maxTurns: z.int().positive(),
				// The budget is in US dollars.
				maxBudget: z.number().positive(),
			})
			.strict(),
	})
	.strict();

// A read tool or a compute tool runs in the sandbox.
// It declares if it can run again after a stop.
const readTool = z
	.object({
		name: z.string().min(1),
		kind: z.literal("read"),
		replay: z.enum(["safe", "unsafe"]),
	})
	.strict();

const computeTool = z
	.object({
		name: z.string().min(1),
		kind: z.literal("compute"),
		replay: z.enum(["safe", "unsafe"]),
	})
	.strict();

// An action tool sends something out or costs money.
// The gate uses its action kind.
const actionTool = z
	.object({
		name: z.string().min(1),
		kind: z.literal("action"),
		actionKind: z.enum(["money", "public", "other"]),
	})
	.strict();

const tool = z.discriminatedUnion("kind", [readTool, computeTool, actionTool]);

function isUnique(names: string[]): boolean {
	return new Set(names).size === names.length;
}

// The definition of a bot is data (decision D29).
export const botDefinition = z
	.object({
		id: z.string().min(1),
		version: z.string().regex(/^\d+\.\d+\.\d+$/, "Use a version like 0.1.0."),
		taskTypes: z.array(taskType).min(1),
		tools: z.array(tool).min(1),
		readList: z.array(z.string().min(1)),
		factPages: z.array(z.string().min(1)),
	})
	.strict()
	.refine((bot) => isUnique(bot.tools.map((t) => t.name)), {
		message: "Each tool name must be unique.",
		path: ["tools"],
	})
	.refine((bot) => isUnique(bot.taskTypes.map((t) => t.name)), {
		message: "Each task type name must be unique.",
		path: ["taskTypes"],
	});

export type BotDefinition = z.infer<typeof botDefinition>;
