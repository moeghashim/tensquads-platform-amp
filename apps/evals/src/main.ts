// The command `npm run evals` (requirements E2, E3 and E5). It plays the cases of evals/cases through the full path
// and prints the report of each version, the comparison of the first two versions, and the eval of the decider.
// Options: --runs N (default 3), --versions a,b (default base), --cases K3,D3 (default all).
// Settings: DATABASE_URL and DB_USER_PASSWORD, as for the tests of the full path.
import { parseArgs } from "node:util";

import { formatDeciderReport } from "@tensquads/evals";

import { runDeciderEvals } from "./decider.js";
import { loadCases, loadDeciderItems, loadVersions } from "./files.js";
import { runEvals } from "./run.js";

const { values } = parseArgs({
	options: {
		runs: { type: "string", default: "3" },
		versions: { type: "string", default: "base" },
		cases: { type: "string" },
	},
});

const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) throw new Error("The option --runs is not a positive whole number.");
const list = (text: string) =>
	text
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");

const log = (line: string) => console.log(line);
const cases = loadCases(values.cases === undefined ? undefined : list(values.cases));
log(`Evals: ${cases.length} cases, ${runs} runs of each case.`);
await runEvals({ versions: loadVersions(list(values.versions)), cases, runs, log });
for (const report of await runDeciderEvals(loadDeciderItems())) log(formatDeciderReport(report));
