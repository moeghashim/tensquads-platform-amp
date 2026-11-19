// The rules of the owner (requirements G2 and G3).
// A money action at or below the newest "money_limit" runs with no approval. A public action always needs one.
// A "money_limit" rule can have reasons (task 09). Then a money action at or below the limit also needs three sure
// "yes" answers of the decider about the message of the customer. The decider reads, and this code decides (Q7).
import type { ActionKind, GateStore } from "./types.js";

export const MONEY_LIMIT = "money_limit";

// The amounts of a rule are in millionths of a US dollar.
const MICROS = 1_000_000;

export type RuleCheck = { needs: "nothing" } | { needs: "approval"; ruleId: string | null; limit: number | null };

function maxAmountOf(params: Record<string, unknown>): number | null {
	const { maxAmount } = params;
	return typeof maxAmount === "number" && Number.isInteger(maxAmount) && maxAmount >= 0 ? maxAmount : null;
}

// The reasons of the rule, for example "damaged or missing", or null when the rule has none.
function reasonsOf(params: Record<string, unknown>): string | null {
	const { reasons } = params;
	return typeof reasons === "string" && reasons.trim() !== "" ? reasons : null;
}

// True only when the decider gave three sure "yes" answers. The gate gives the task and the action.
export type ReasonCheck = (reasons: string) => Promise<boolean>;

// The reasons need three sure "yes" answers. With no check, or another answer, the owner decides (Q4, Q7).
async function reasonsCheck(params: Record<string, unknown>, check: ReasonCheck | undefined): Promise<boolean> {
	const reasons = reasonsOf(params);
	if (reasons === null) return true;
	return check ? check(reasons) : false;
}

async function moneyCheck(store: GateStore, content: Record<string, unknown>, check?: ReasonCheck): Promise<RuleCheck> {
	const rule = await store.activeRule(MONEY_LIMIT);
	const limit = rule ? maxAmountOf(rule.params) : null;
	const amount = Math.round(Number(content.amount) * MICROS);
	// Above the limit, the owner always decides. The decider is not asked.
	const inLimit = rule !== undefined && limit !== null && amount <= limit;
	if (inLimit && (await reasonsCheck(rule.params, check))) return { needs: "nothing" };
	return { needs: "approval", ruleId: rule?.ruleId ?? null, limit };
}

// The gate reads the amount and the kind from the request. The check asks the decider about the reasons.
export function ruleCheck(
	store: GateStore,
	kind: ActionKind,
	content: Record<string, unknown>,
	check?: ReasonCheck,
): Promise<RuleCheck> {
	if (kind === "money") return moneyCheck(store, content, check);
	if (kind === "public") return Promise.resolve({ needs: "approval", ruleId: null, limit: null });
	return Promise.resolve({ needs: "nothing" });
}
