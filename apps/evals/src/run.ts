// The runner of evals (requirements E2 and E3). For each version it starts the Worker with the settings of the
// version, plays each case several times, each run in a new test account, and grades each run.
// The setup of a case can need its own settings of the Worker (the outcomes of the services and the fixed decider).
// Then the version starts one more Worker for those cases.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ruleChecker } from "@tensquads/adapters-test";
import type { EvalCase, EvalVersion } from "@tensquads/contracts";
import { ports, startSystem } from "@tensquads/core";
import {
	type Comparison,
	compareVersions,
	formatComparison,
	formatReport,
	type GradeDeps,
	gradeRun,
	type RunResult,
	type VersionReport,
	versionReport,
} from "@tensquads/evals";

import { EVALS_DIR } from "./files.js";
import { EvalWorker, setupVars } from "./play.js";

export interface EvalOptions {
	versions: readonly EvalVersion[];
	cases: readonly EvalCase[];
	runs: number;
	log: (line: string) => void;
}

export interface EvalOutcome {
	reports: VersionReport[];
	// The comparison of the first two versions.
	comparison: Comparison | undefined;
	// The log of each Worker, for a check of the mode with no outgoing action.
	workerLogs: string[];
	// The test account and the cost in the report of each run.
	runs: RunCost[];
}

export interface RunCost {
	version: string;
	accountId: string;
	cost: number;
}

// The id of each run. Each id is new, so each run has a new test account.
const STAMP = Date.now().toString(36);
const accountOf = (version: string, caseId: string, runNo: number) =>
	`eval-${STAMP}-${version}-${caseId}-${runNo}`.toLowerCase();

// The cases of one Worker: each case whose setup needs the same settings of the Worker.
function groups(cases: readonly EvalCase[]): Map<string, EvalCase[]> {
	const found = new Map<string, EvalCase[]>();
	for (const item of cases) {
		const key = JSON.stringify(setupVars(item.setup));
		found.set(key, [...(found.get(key) ?? []), item]);
	}
	return found;
}

// The person grader writes each run to evals/review/<run>.json. The folder is not in git.
const review: GradeDeps["review"] = async (entry) => {
	const dir = join(EVALS_DIR, "review");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${entry.run}.json`), `${JSON.stringify(entry, null, "\t")}\n`);
};

async function runGroup(
	version: EvalVersion,
	cases: readonly EvalCase[],
	options: EvalOptions,
	deps: GradeDeps,
): Promise<{ results: RunResult[]; runs: RunCost[]; workerLog: string }> {
	const [first] = cases;
	if (!first) return { results: [], runs: [], workerLog: "" };
	const worker = new EvalWorker({ ...setupVars(first.setup), ...version.worker });
	const results: RunResult[] = [];
	const runs: RunCost[] = [];
	await worker.start();
	try {
		for (const item of cases) {
			for (let runNo = 1; runNo <= options.runs; runNo += 1) {
				const played = await worker.play(item, accountOf(version.name, item.id, runNo));
				const grade = await gradeRun(item, played.accountId, played.record, deps);
				const cost = await worker.cost(played.accountId);
				options.log(`${version.name} ${item.id} run ${runNo}: ${grade.verdict}`);
				results.push({ caseId: item.id, runNo, ...grade, cost, ms: played.ms });
				runs.push({ version: version.name, accountId: played.accountId, cost });
			}
		}
	} finally {
		await worker.stop();
	}
	return { results, runs, workerLog: worker.path.workerLog };
}

export async function runEvals(options: EvalOptions): Promise<EvalOutcome> {
	const checker = (await startSystem([ruleChecker()])).port(ports.checkerModel);
	const deps: GradeDeps = { checker, review };
	const reports: VersionReport[] = [];
	const workerLogs: string[] = [];
	const runs: RunCost[] = [];
	for (const version of options.versions) {
		const results: RunResult[] = [];
		for (const group of groups(options.cases).values()) {
			const done = await runGroup(version, group, options, deps);
			results.push(...done.results);
			runs.push(...done.runs);
			workerLogs.push(done.workerLog);
		}
		// The report keeps the order of the cases.
		const order = options.cases.map((item) => item.id);
		results.sort((a, b) => order.indexOf(a.caseId) - order.indexOf(b.caseId) || a.runNo - b.runNo);
		const report = versionReport(version.name, results);
		reports.push(report);
		options.log(formatReport(report));
	}
	const [a, b] = reports;
	const comparison = a && b ? compareVersions(a, b) : undefined;
	if (comparison) options.log(formatComparison(comparison));
	return { reports, comparison, workerLogs, runs };
}
