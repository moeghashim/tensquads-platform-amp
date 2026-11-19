// The costs of an account (docs/ARCHITECTURE.md, sections 7.1 and 7.6, requirements S1, S2 and S9).
// A cost is what we pay: one row for each thing, with its account, its task and its attempt.
// This package holds the rules. Petra writes the rows. The cost of a task is a query on its rows.
import type { Command } from "@tensquads/contracts";
import type { CallUsage, ModelAnswer } from "@tensquads/core";

export type CostKind =
	| "large model"
	| "decider"
	| "checker model"
	| "sandbox"
	| "outside service"
	| "storage"
	| "database"
	| "worker";

export interface NewCost {
	sourceRef: string;
	taskId: string | null;
	attemptNo: number | null;
	kind: CostKind;
	provider: string;
	model: string;
	units: number;
	unit: string;
	// The price of one unit at the time of the cost, in millionths of a US dollar.
	unitPrice: number;
	amount: number;
	divided: boolean;
	// The UTC month of a share, for example 2026-11. Null for a row that is not divided.
	period: string | null;
	at: string;
}

// The writer of Petra gives this store (requirement P2). A row with a key that is there does not change.
export interface CostStore {
	// The price of the newest unit_prices row with starts_at at or before the time, or undefined (S2).
	unitPrice(price: { provider: string; model: string; unit: string; at: string }): Promise<number | undefined>;
	addCost(row: NewCost): Promise<void>;
	// The sum of the cost rows of the task, over all its attempts. No column holds it (S3).
	taskCost(taskId: string): Promise<number>;
}

// The cause of a cost. A gateway call has its task, attempt and call number. A command has its key.
export type CostRef = { taskId: string; attemptNo: number; callNo: number } | { cause: string; taskId: string | null };

export type AddCostShare = Extract<Command, { type: "AddCostShare" }>;

export interface Costs {
	// Two rows for one model call: one for the input tokens and one for the output tokens.
	modelCall(ref: CostRef, answer: ModelAnswer): Promise<void>;
	// One row for each usage of a call of the checker model or of a decider.
	usage(ref: CostRef, kind: CostKind, usage: readonly CallUsage[]): Promise<void>;
	// The milliseconds of the sandbox since the previous gateway call of the attempt (call "step").
	sandbox(ref: { taskId: string; attemptNo: number; callNo: number }, ms: number): Promise<void>;
	// One call of an outside service that answered "done".
	outsideService(call: { taskId: string; attemptNo: number; toolCallId: string; provider: string }): Promise<void>;
	// One share of a shared cost, or the row that cancels it (S4, S5). Its command id ends with "/cancel".
	share(command: AddCostShare): Promise<void>;
	taskCost(taskId: string): Promise<number>;
	// True when the cost rows of the task are at the maximum budget or above it (S9). The budget is in US dollars.
	overBudget(taskId: string, maxBudget: number): Promise<boolean>;
}

const MILLION = 1_000_000;
// The unit of the sandbox. Its units are milliseconds, so its price is the price of one million units.
const SANDBOX_UNIT = "1k seconds";
// A price for "1M ..." or for 1k seconds is the price of one million units.
const PER_MILLION = /^1M |^1k seconds$/;

// The amount in whole millionths of a US dollar. A price for one million units is rounded half up.
export function amountOf(units: number, unit: string, unitPrice: number): number {
	return PER_MILLION.test(unit) ? Math.floor((units * unitPrice + MILLION / 2) / MILLION) : units * unitPrice;
}

const INPUT = "1M input tokens";
const OUTPUT = "1M output tokens";

// The last part of the key of a usage row: "input", "output" or the unit.
const unitKey = (unit: string) => (unit === INPUT ? "input" : unit === OUTPUT ? "output" : unit);

// The key of one request to a provider (section 7.1).
function requestRef(ref: CostRef, requestId: string, unit: string): string {
	const base = "cause" in ref ? `${ref.cause}/model` : `model/${ref.taskId}/${ref.attemptNo}/${ref.callNo}`;
	return `${base}/${requestId}/${unitKey(unit)}`;
}

const attemptOf = (ref: CostRef) => ("attemptNo" in ref ? ref.attemptNo : null);

export function costs(deps: { store: CostStore; now: () => string }): Costs {
	const { store } = deps;

	// A cost with no price gets the price 0 and the amount 0. The operations view lists it.
	async function add(row: Omit<NewCost, "unitPrice" | "amount" | "divided" | "period" | "at">): Promise<void> {
		const at = deps.now();
		const unitPrice = (await store.unitPrice({ ...row, at })) ?? 0;
		const amount = amountOf(row.units, row.unit, unitPrice);
		await store.addCost({ ...row, unitPrice, amount, divided: false, period: null, at });
	}

	async function usage(ref: CostRef, kind: CostKind, list: readonly CallUsage[]): Promise<void> {
		for (const item of list) {
			const { provider, model, units, unit } = item;
			const sourceRef = requestRef(ref, item.requestId, unit);
			await add({ sourceRef, taskId: ref.taskId, attemptNo: attemptOf(ref), kind, provider, model, units, unit });
		}
	}

	return {
		modelCall: (ref, answer) =>
			usage(ref, "large model", [
				{ ...answer, units: answer.usage.inputTokens, unit: INPUT },
				{ ...answer, units: answer.usage.outputTokens, unit: OUTPUT },
			]),
		usage,
		sandbox: (ref, ms) =>
			add({
				sourceRef: `task/${ref.taskId}/${ref.attemptNo}/${ref.callNo}/sandbox`,
				taskId: ref.taskId,
				attemptNo: ref.attemptNo,
				kind: "sandbox",
				provider: "launcher",
				model: "",
				units: ms,
				unit: SANDBOX_UNIT,
			}),
		outsideService: (call) =>
			add({
				sourceRef: `action/${call.taskId}/${call.toolCallId}/service`,
				taskId: call.taskId,
				attemptNo: call.attemptNo,
				kind: "outside service",
				provider: call.provider,
				model: "",
				units: 1,
				unit: "call",
			}),
		// A share is one unit with the amount as its price. The amount of a cancel row is negative.
		share: (command) =>
			store.addCost({
				sourceRef: `shared/${command.sharedCostId}${command.commandId.endsWith("/cancel") ? "/cancel" : ""}`,
				taskId: null,
				attemptNo: null,
				kind: command.kind,
				provider: command.provider,
				model: "",
				units: 1,
				unit: "share",
				unitPrice: command.amount,
				amount: command.amount,
				divided: true,
				period: command.period,
				at: command.at,
			}),
		taskCost: (taskId) => store.taskCost(taskId),
		overBudget: async (taskId, maxBudget) => (await store.taskCost(taskId)) >= Math.round(maxBudget * MILLION),
	};
}
