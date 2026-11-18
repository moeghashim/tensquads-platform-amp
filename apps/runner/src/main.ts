// The runner. It runs the agent loop of one bot for one attempt of one task, in a sandbox.
// Its only inputs are the settings PASS and WORKER_URL. RUNNER_COMMIT is optional.
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT_ERROR, readSettings, runAttempt } from "./run.js";

// The commit of the runner (requirement L11). The launcher gives it, or git finds it.
function runnerCommit(): string {
	const fromEnv = process.env.RUNNER_COMMIT;
	if (fromEnv !== undefined && fromEnv !== "") {
		return fromEnv;
	}
	try {
		const cwd = dirname(fileURLToPath(import.meta.url));
		return execFileSync("git", ["rev-parse", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "unknown";
	}
}

function log(line: string): void {
	console.error(`runner: ${line}`);
}

async function main(): Promise<number> {
	try {
		const settings = readSettings(process.env);
		return await runAttempt({ ...settings, runnerCommit: runnerCommit(), log });
	} catch (error) {
		log(error instanceof Error ? error.message : String(error));
		return EXIT_ERROR;
	}
}

process.exitCode = await main();
