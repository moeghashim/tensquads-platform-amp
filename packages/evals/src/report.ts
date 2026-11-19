// The report of one version and the comparison of two versions (requirements E2 and E3, decision D26).
// A case passes only when all its runs pass. A case with a run that a person must decide is "not decided".
import type { Verdict } from "./grade.js";

export interface RunResult {
	caseId: string;
	// The number of the run, from 1.
	runNo: number;
	verdict: Verdict;
	reasons: readonly string[];
	// The cost of the run from the cost view, in millionths of a US dollar.
	cost: number;
	// The time of the run in milliseconds.
	ms: number;
}

export interface CaseReport {
	caseId: string;
	verdict: Verdict;
	runs: number;
	passedRuns: number;
	// The reasons of the runs that failed, with no repeat.
	reasons: string[];
}

export interface VersionReport {
	version: string;
	cases: CaseReport[];
	// The cases that pass, of the cases that are decided. 0 when no case is decided.
	passRate: number;
	// The pass rate of each run number, over the decided cases.
	runPassRates: number[];
	// The standard deviation of the pass rates of the runs.
	deviation: number;
	notDecided: number;
	cost: number;
	ms: number;
}

function caseVerdict(results: readonly RunResult[]): Verdict {
	if (results.some((result) => result.verdict === "fail")) return "fail";
	if (results.some((result) => result.verdict === "not decided")) return "not decided";
	return "pass";
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const rate = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);

function deviationOf(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const mean = sum(values) / values.length;
	return Math.sqrt(sum(values.map((value) => (value - mean) ** 2)) / values.length);
}

export function versionReport(version: string, results: readonly RunResult[]): VersionReport {
	const ids = [...new Set(results.map((result) => result.caseId))];
	const cases = ids.map((caseId): CaseReport => {
		const own = results.filter((result) => result.caseId === caseId);
		return {
			caseId,
			verdict: caseVerdict(own),
			runs: own.length,
			passedRuns: own.filter((result) => result.verdict === "pass").length,
			reasons: [...new Set(own.flatMap((result) => result.reasons))],
		};
	});
	const decided = new Set(cases.filter((item) => item.verdict !== "not decided").map((item) => item.caseId));
	const runNos = [...new Set(results.map((result) => result.runNo))].sort((a, b) => a - b);
	const runPassRates = runNos.map((runNo) => {
		const own = results.filter((result) => result.runNo === runNo && decided.has(result.caseId));
		return rate(own.filter((result) => result.verdict === "pass").length, own.length);
	});
	return {
		version,
		cases,
		passRate: rate(cases.filter((item) => item.verdict === "pass").length, decided.size),
		runPassRates,
		deviation: deviationOf(runPassRates),
		notDecided: cases.length - decided.size,
		cost: sum(results.map((result) => result.cost)),
		ms: sum(results.map((result) => result.ms)),
	};
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
export const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(6)}`;

export function formatReport(report: VersionReport): string {
	const decided = report.cases.length - report.notDecided;
	const passed = report.cases.filter((item) => item.verdict === "pass").length;
	const runs = sum(report.cases.map((item) => item.runs));
	const lines = [
		`Version ${report.version}`,
		`  Pass rate: ${percent(report.passRate)} (${passed} of ${decided} cases)`,
		`  Variation: standard deviation ${report.deviation.toFixed(4)} of the pass rates of the runs [${report.runPassRates.map(percent).join(", ")}]`,
		`  Not decided: ${report.notDecided}`,
		`  Cost: ${dollars(report.cost)} for ${runs} runs (${dollars(rate(report.cost, runs))} for each run)`,
		`  Time: ${(report.ms / 1000).toFixed(1)} s for ${runs} runs (${(rate(report.ms, runs) / 1000).toFixed(1)} s for each run)`,
		"  Cases:",
	];
	for (const item of report.cases) {
		lines.push(`    ${item.caseId.padEnd(6)} ${item.verdict.padEnd(11)} ${item.passedRuns}/${item.runs} runs passed`);
		for (const reason of item.reasons) lines.push(`           - ${reason}`);
	}
	return lines.join("\n");
}

export interface Comparison {
	a: string;
	b: string;
	// Each case that passed in A and fails in B, by name. A better average of B does not hide it.
	regressions: string[];
	// Each case that failed in A and passes in B.
	fixed: string[];
	passRates: [number, number];
}

export function compareVersions(a: VersionReport, b: VersionReport): Comparison {
	const verdictIn = (report: VersionReport, caseId: string) =>
		report.cases.find((item) => item.caseId === caseId)?.verdict;
	const named = (from: Verdict, to: Verdict) =>
		a.cases.filter((item) => item.verdict === from && verdictIn(b, item.caseId) === to).map((item) => item.caseId);
	return {
		a: a.version,
		b: b.version,
		regressions: named("pass", "fail"),
		fixed: named("fail", "pass"),
		passRates: [a.passRate, b.passRate],
	};
}

const list = (names: readonly string[]) => (names.length === 0 ? "none" : names.join(", "));

export function formatComparison(comparison: Comparison): string {
	return [
		`Comparison: A = ${comparison.a}, B = ${comparison.b}`,
		`  Pass rate: A ${percent(comparison.passRates[0])}, B ${percent(comparison.passRates[1])}`,
		`  Passed in A and fails in B: ${list(comparison.regressions)}`,
		`  Failed in A and passes in B: ${list(comparison.fixed)}`,
	].join("\n");
}
