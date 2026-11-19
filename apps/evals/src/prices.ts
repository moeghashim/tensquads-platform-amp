// The prices of the test adapters for the evals, in millionths of a US dollar for one unit (or for one million units
// of a unit "1M ..." or "1k seconds"). The runner of evals sets them with SetUnitPrice, so the cost view has a cost.
// They are not real prices. They only make the costs of two versions comparable.
import type { CallUsage } from "@tensquads/core";
import { amountOf } from "@tensquads/costs";

interface Price {
	provider: string;
	model: string;
	unit: string;
	price: number;
}

export const EVAL_PRICES: readonly Price[] = [
	{ provider: "test", model: "rule", unit: "1M input tokens", price: 150_000 },
	{ provider: "test", model: "rule", unit: "1M output tokens", price: 600_000 },
	{ provider: "test", model: "rule-check", unit: "call", price: 100 },
	{ provider: "test", model: "fixed", unit: "call", price: 50 },
	{ provider: "launcher", model: "", unit: "1k seconds", price: 50_000 },
	{ provider: "test-payment", model: "", unit: "call", price: 2_000 },
	{ provider: "test-channel", model: "", unit: "call", price: 1_000 },
];

// The prices start before each eval run.
export const PRICES_FROM = "2026-01-01T00:00:00.000Z";

// The cost of the usage of one call, with the prices of the evals. A unit with no price costs 0.
export function usageCost(usage: readonly CallUsage[]): number {
	return usage.reduce((total, item) => {
		const price = EVAL_PRICES.find(
			(entry) => entry.provider === item.provider && entry.model === item.model && entry.unit === item.unit,
		);
		return total + amountOf(item.units, item.unit, price?.price ?? 0);
	}, 0);
}
