// The eval of a decider (docs/ARCHITECTURE.md, section 4.7, requirement E5).
// It asks each labelled message, one at a time, and reports for each decision point: the agreement, the wrong
// answers above the level, the mean time and the cost. The caller joins the decider and the decisions package
// (this package does not import them, requirement C2), so the code compares the probability with the level.
import type { DeciderItem } from "@tensquads/contracts";

import { dollars } from "./report.js";

// The verdict of the code for one message.
export interface DeciderRun {
	answer: string | null;
	probability: number | null;
	// True when the answer is valid and at or above the level of the point.
	sure: boolean;
	ms: number;
	// In millionths of a US dollar.
	cost: number;
}

export interface PointReport {
	point: string;
	items: number;
	// The answers that agree with the label, of all items.
	agreement: number;
	// The answers that are wrong and that the code used, because they were at or above the level.
	wrongAboveLevel: number;
	meanMs: number;
	cost: number;
}

export interface DeciderReport {
	decider: string;
	points: PointReport[];
}

export async function deciderEval(
	decider: string,
	items: readonly DeciderItem[],
	ask: (item: DeciderItem) => Promise<DeciderRun>,
): Promise<DeciderReport> {
	const runs: { item: DeciderItem; run: DeciderRun }[] = [];
	for (const item of items) runs.push({ item, run: await ask(item) });
	const points = [...new Set(items.map((item) => item.point))].map((point): PointReport => {
		const own = runs.filter(({ item }) => item.point === point);
		const wrong = own.filter(({ item, run }) => run.answer !== item.answer);
		return {
			point,
			items: own.length,
			agreement: (own.length - wrong.length) / own.length,
			wrongAboveLevel: wrong.filter(({ run }) => run.sure).length,
			meanMs: Math.round(own.reduce((total, { run }) => total + run.ms, 0) / own.length),
			cost: own.reduce((total, { run }) => total + run.cost, 0),
		};
	});
	return { decider, points };
}

export function formatDeciderReport(report: DeciderReport): string {
	const lines = [
		`Decider ${report.decider}`,
		`  ${"Point".padEnd(16)} ${"Items".padEnd(5)} ${"Agree".padEnd(6)} Wrong above level  Time     Cost`,
	];
	for (const point of report.points) {
		lines.push(
			`  ${point.point.padEnd(16)} ${String(point.items).padEnd(5)} ${`${(point.agreement * 100).toFixed(1)}%`.padEnd(6)} ${String(point.wrongAboveLevel).padEnd(17)}  ${`${point.meanMs} ms`.padEnd(8)} ${dollars(point.cost)}`,
		);
	}
	return lines.join("\n");
}
