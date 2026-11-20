// The internal steps of Petra for one command, for the owner read GET /v1/commands/{commandId}/steps.
// Petra keeps her model calls and her tool runs in the storage of the Durable Object, with the prefix "petra_"
// (section 7.3). The decisions and the costs of the command come from their tables. A step has names, times,
// counts and amounts. It has no text of a message and no key.
import type { CommandStep, CommandStepsAnswer } from "@tensquads/contracts";

import type { PetraStorage } from "./outbox.js";
import type { PetraToolDefinition } from "./petra-tools.js";

// The steps that Petra keeps in her storage: one model call or one tool run.
export type RunStep = Extract<CommandStep, { kind: "model" | "tool" }>;

export interface StepStorage extends PetraStorage {
	delete(key: string): Promise<unknown>;
}

export interface StepLog {
	add(commandId: string, step: RunStep): Promise<void>;
	steps(commandId: string): Promise<RunStep[]>;
}

// The list of the commands that have steps, oldest first.
const INDEX_KEY = "petra_steps";
const stepKey = (commandId: string) => `petra_steps/${commandId}`;
// The storage keeps the steps of the last commands only. They are not a record (section 7.3).
const KEPT_COMMANDS = 50;

export function stepLog(storage: StepStorage): StepLog {
	return {
		async add(commandId, step) {
			const key = stepKey(commandId);
			const steps = (await storage.get<RunStep[]>(key)) ?? [];
			if (steps.length === 0) {
				const index = [...((await storage.get<string[]>(INDEX_KEY)) ?? []), commandId];
				const removed = index.splice(0, Math.max(0, index.length - KEPT_COMMANDS));
				for (const old of removed) await storage.delete(stepKey(old));
				await storage.put(INDEX_KEY, index);
			}
			await storage.put(key, [...steps, step]);
		},
		steps: async (commandId) => (await storage.get<RunStep[]>(stepKey(commandId))) ?? [],
	};
}

// Each tool run with a command id is one step, with its time. A tool that throws is a failed step. The error goes on.
export function timedTools(tools: readonly PetraToolDefinition[], log: Pick<StepLog, "add">): PetraToolDefinition[] {
	return tools.map((tool) => ({
		...tool,
		async execute(input) {
			const started = Date.now();
			const record = async (failed: boolean) => {
				if (typeof input.commandId !== "string") return;
				const at = new Date(started).toISOString();
				await log.add(input.commandId, { kind: "tool", at, tool: tool.name, ms: Date.now() - started, failed });
			};
			let output: string;
			try {
				output = await tool.execute(input);
			} catch (error) {
				await record(true);
				throw error;
			}
			await record(false);
			return output;
		},
	}));
}

type DecisionStep = Extract<CommandStep, { kind: "decision" }>;
type CostStep = Extract<CommandStep, { kind: "cost" }>;

export interface CommandStepsDeps {
	log: Pick<StepLog, "steps">;
	// The rows of decisions and costs with a source reference that starts with "cmd/{commandId}/".
	decisions: (commandId: string) => Promise<DecisionStep[]>;
	costs: (commandId: string) => Promise<CostStep[]>;
}

// All the steps of one command, in the sequence of their times. The tables keep their own sequence for equal times.
export async function commandSteps(deps: CommandStepsDeps, commandId: string): Promise<CommandStepsAnswer> {
	const [run, decisions, costs] = await Promise.all([
		deps.log.steps(commandId),
		deps.decisions(commandId),
		deps.costs(commandId),
	]);
	const steps = [...run, ...decisions, ...costs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	return { commandId, steps };
}
