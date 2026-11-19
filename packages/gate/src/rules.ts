// The rules of the owner (requirements G2 and G3).
// A money action at or below the newest "money_limit" runs with no approval. A public action always needs one.
import type { ActionKind, GateStore } from "./types.js";

export const MONEY_LIMIT = "money_limit";

// The amounts of a rule are in millionths of a US dollar.
const MICROS = 1_000_000;

export type RuleCheck = { needs: "nothing" } | { needs: "approval"; ruleId: string | null; limit: number | null };

function maxAmountOf(params: Record<string, unknown>): number | null {
	const { maxAmount } = params;
	return typeof maxAmount === "number" && Number.isInteger(maxAmount) && maxAmount >= 0 ? maxAmount : null;
}

async function moneyCheck(store: GateStore, content: Record<string, unknown>): Promise<RuleCheck> {
	const rule = await store.activeRule(MONEY_LIMIT);
	const limit = rule ? maxAmountOf(rule.params) : null;
	const amount = Math.round(Number(content.amount) * MICROS);
	if (limit !== null && amount <= limit) return { needs: "nothing" };
	return { needs: "approval", ruleId: rule?.ruleId ?? null, limit };
}

// The gate reads the amount and the kind from the request. Task 09 adds the decider.
export function ruleCheck(store: GateStore, kind: ActionKind, content: Record<string, unknown>): Promise<RuleCheck> {
	if (kind === "money") return moneyCheck(store, content);
	if (kind === "public") return Promise.resolve({ needs: "approval", ruleId: null, limit: null });
	return Promise.resolve({ needs: "nothing" });
}
