import assert from "node:assert/strict";
import { test } from "node:test";

import { compareVersions, formatComparison, formatReport, type RunResult, versionReport } from "../src/index.js";

const run = (caseId: string, runNo: number, verdict: RunResult["verdict"], cost = 100, ms = 1000): RunResult => ({
	caseId,
	runNo,
	verdict,
	reasons: verdict === "fail" ? ["A check failed."] : [],
	cost,
	ms,
});

test("E2: a case passes only when all its runs pass; the report has the pass rate, the variation, the cost and the time", () => {
	const report = versionReport("base", [
		run("K3", 1, "pass"),
		run("K3", 2, "pass"),
		run("K3", 3, "pass"),
		run("D3", 1, "pass"),
		run("D3", 2, "fail"),
		run("D3", 3, "pass"),
		run("X1", 1, "not decided"),
		run("X1", 2, "not decided"),
		run("X1", 3, "not decided"),
	]);
	assert.equal(report.version, "base");
	assert.deepEqual(
		report.cases.map((item) => [item.caseId, item.verdict, item.passedRuns, item.runs]),
		[
			["K3", "pass", 3, 3],
			["D3", "fail", 2, 3],
			["X1", "not decided", 0, 3],
		],
	);
	// Two cases are decided, and one of them passes.
	assert.equal(report.passRate, 0.5);
	// The pass rate of each run: 1, 0.5, 1. The standard deviation is 0.2357.
	assert.deepEqual(report.runPassRates, [1, 0.5, 1]);
	assert.equal(report.deviation.toFixed(4), "0.2357");
	assert.equal(report.notDecided, 1);
	assert.equal(report.cost, 900);
	assert.equal(report.ms, 9000);
	const text = formatReport(report);
	assert.match(text, /Version base/);
	assert.match(text, /Pass rate: 50\.0% \(1 of 2 cases\)/);
	assert.match(text, /D3 +fail +2\/3 runs passed/);
	assert.match(text, /Cost: \$0\.000900/);
});

test("E3: the comparison names each case that passed in A and fails in B, also when the average of B is better", () => {
	const a = versionReport("A", [
		run("K3", 1, "pass"),
		run("D3", 1, "fail"),
		run("S4", 1, "fail"),
		run("P2", 1, "pass"),
	]);
	const b = versionReport("B", [
		run("K3", 1, "fail"),
		run("D3", 1, "pass"),
		run("S4", 1, "pass"),
		run("P2", 1, "pass"),
	]);
	assert.ok(b.passRate > a.passRate, "The average of B is better.");
	const comparison = compareVersions(a, b);
	assert.deepEqual(comparison.regressions, ["K3"]);
	assert.deepEqual(comparison.fixed, ["D3", "S4"]);
	assert.match(formatComparison(comparison), /Passed in A and fails in B: K3/);
	assert.deepEqual(compareVersions(a, a).regressions, []);
	assert.match(formatComparison(compareVersions(a, a)), /Passed in A and fails in B: none/);
});
