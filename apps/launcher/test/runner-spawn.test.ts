import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";

import { runnerSpawn } from "../src/runner-spawn.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

// The launcher has more settings than a runner needs. A setting that names the cases must not reach the runner.
const LAUNCHER_ENV = {
	PATH: "/usr/bin:/bin",
	RUNNER_COMMIT: "abc123",
	LAUNCHER_KEY: "launcher-key",
	EVALS_CASES: join(ROOT, "evals", "cases"),
	HOME: ROOT,
};

test("E6: the launcher starts the runner in a new temp directory, with no path to the cases in its arguments or env", () => {
	for (const runnerCommand of [undefined, "node my-runner.js"]) {
		const spawn = runnerSpawn("the-pass", { workerUrl: "http://127.0.0.1:1", env: LAUNCHER_ENV, runnerCommand });
		try {
			const fromTemp = relative(realpathSync(tmpdir()), realpathSync(spawn.cwd));
			assert.ok(!fromTemp.startsWith(".."), `The directory ${spawn.cwd} is not in the temp directory.`);
			assert.ok(relative(ROOT, spawn.cwd).startsWith(".."), "The directory is not in the repository.");
			assert.deepEqual(Object.keys(spawn.env).sort(), ["PASS", "PATH", "RUNNER_COMMIT", "WORKER_URL"]);
			for (const value of [spawn.command, ...spawn.args, ...Object.values(spawn.env)]) {
				assert.doesNotMatch(value, /evals/, `The runner gets "${value}".`);
			}
		} finally {
			spawn.cleanUp();
		}
		assert.equal(existsSync(spawn.cwd), false, "The launcher removes the directory after the runner.");
	}
});

test("E6: two runners get two different directories", () => {
	const settings = { workerUrl: "http://127.0.0.1:1", env: LAUNCHER_ENV };
	const first = runnerSpawn("pass-1", settings);
	const second = runnerSpawn("pass-2", settings);
	assert.notEqual(first.cwd, second.cwd);
	first.cleanUp();
	second.cleanUp();
});
