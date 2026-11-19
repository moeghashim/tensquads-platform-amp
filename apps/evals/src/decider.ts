// The eval of each decider adapter (requirement E5). The adapter is called directly, with no full path.
// The decisions package compares the probability with the level of each point, as in Petra.
import { fixedDecider, modelDecider, ruleModel } from "@tensquads/adapters-test";
import type { DeciderItem } from "@tensquads/contracts";
import { type DecisionRecord, type Plugin, ports, startSystem } from "@tensquads/core";
import { decisions, type PointId } from "@tensquads/decisions";
import { type DeciderReport, deciderEval } from "@tensquads/evals";

import { usageCost } from "./prices.js";

// Each decider adapter, with the plug-ins that it needs. The model decider asks the rule model.
const ADAPTERS: readonly { name: string; plugins: () => Plugin[] }[] = [
	{ name: "fixed", plugins: () => [fixedDecider()] },
	{ name: "model", plugins: () => [ruleModel(), modelDecider()] },
];

const TIMEOUT_MS = 5000;

async function evalOne(name: string, plugins: Plugin[], items: readonly DeciderItem[]): Promise<DeciderReport> {
	const system = await startSystem(plugins);
	const records: DecisionRecord[] = [];
	let cost = 0;
	const decide = decisions({
		store: { decisionRow: async () => undefined, addDecision: async (row) => void records.push(row) },
		decider: system.port(ports.decider),
		shadow: null,
		timeoutMs: TIMEOUT_MS,
		now: () => new Date().toISOString(),
		costs: {
			usage: async (_ref, _kind, usage) => {
				cost += usageCost(usage);
			},
		},
	});
	let index = 0;
	try {
		return await deciderEval(name, items, async (item) => {
			index += 1;
			const before = cost;
			const [verdict] = await decide.ask([
				{
					sourceRef: `eval/${index}/${item.point}`,
					point: item.point as PointId,
					taskId: null,
					messageSeq: null,
					message: item.message,
					...(item.rule === undefined ? {} : { rule: item.rule }),
				},
			]);
			if (!verdict) throw new Error(`The decider ${name} gave no verdict.`);
			const { answer, probability, sure } = verdict;
			return { answer, probability, sure, ms: records.at(-1)?.ms ?? 0, cost: cost - before };
		});
	} finally {
		await system.stop();
	}
}

export async function runDeciderEvals(items: readonly DeciderItem[]): Promise<DeciderReport[]> {
	const reports: DeciderReport[] = [];
	for (const adapter of ADAPTERS) reports.push(await evalOne(adapter.name, adapter.plugins(), items));
	return reports;
}
