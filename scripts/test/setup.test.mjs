// The setup for a developer and for CI (PRD section 8, V1 to V3). These requirements are about the repository and
// the CI workflow, so the tests read those files. Each test fails when a step that the requirement needs is removed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { root } from "./helpers.mjs";

const read = (path) => readFileSync(join(root, path), "utf8");
const scripts = JSON.parse(read("package.json")).scripts;
const readme = read("README.md");

// The lines of one job of ci.yml, from its name to the next job.
function jobOf(workflow, name) {
	const lines = workflow.split("\n");
	const start = lines.indexOf(`  ${name}:`);
	assert.ok(start >= 0, `ci.yml has the job ${name}`);
	const end = lines.findIndex((line, index) => index > start && /^ {2}[\w-]+:$/.test(line));
	return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

test("V1: one command applies the migrations, then starts the Worker in the local emulator and the launcher", () => {
	assert.equal(scripts["dev:platform"], "node scripts/dev.mjs");
	const dev = read("scripts/dev.mjs");
	const setup = dev.indexOf('run("npm", ["run", "db:setup"]');
	const worker = dev.indexOf('"dev", "-w", "@tensquads/platform"');
	const launcher = dev.indexOf('"start", "-w", "@tensquads/launcher"');
	assert.ok(setup >= 0 && worker > setup && launcher > setup, "db:setup runs before the Worker and the launcher");
	assert.match(read("apps/platform/package.json"), /"dev": "wrangler dev/);
	assert.match(readme, /npm run dev:platform/);
});

test("V2: the CI job that runs npm test has a real Postgres and applies the roles and the row-level security first", () => {
	const job = jobOf(read(".github/workflows/ci.yml"), "required-checks");
	assert.match(job, /services:\n\s+postgres:\n\s+image: postgres:17/);
	assert.match(job, /DATABASE_URL: postgres:\/\/\S+@127\.0\.0\.1:5432\//);
	const setup = job.indexOf("run: npm run db:setup");
	assert.ok(setup >= 0 && setup < job.indexOf("run: npm test"), "db:setup runs before npm test");
	assert.equal(scripts["db:setup"], "npm run db:migrate && npm run db:users");
	assert.match(read("db/0001_roles.sql"), /ts_petra[\s\S]*ts_platform[\s\S]*ts_admin_views/);
	assert.match(read("db/0004_security.sql"), /ENABLE ROW LEVEL SECURITY/);
});

test("V3: the steps of README.md for a new clone are npm ci, db:setup, doctor, check and npm test, in this order", () => {
	const steps = ["npm ci", "npm run db:setup", "npm run doctor", "npm run check", "npm test"];
	const at = steps.map((step) => readme.indexOf(`\n${step}\n`));
	for (const [index, step] of steps.entries()) assert.ok(at[index] >= 0, `README.md has the step ${step}`);
	assert.deepEqual(
		at,
		[...at].sort((a, b) => a - b),
		"the steps are in order",
	);
	assert.equal(scripts.doctor, "node scripts/doctor.mjs");
});
