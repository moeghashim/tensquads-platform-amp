// The launcher. It starts one runner process for each sandbox request. It stands in for boat.dev (section 3.6).
// Settings: WORKER_URL and LAUNCHER_KEY. RUNNER_COMMAND is optional: a shell command that starts one runner.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type RunnerChild, startLauncher } from "./launcher.js";

const RUNNER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "runner");

function log(line: string): void {
	console.error(`launcher: ${line}`);
}

// The message names a missing setting and never its value (section 10).
function setting(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") {
		log(`The setting ${name} is missing.`);
		process.exit(1);
	}
	return value;
}

const workerUrl = setting("WORKER_URL");
const launcherKey = setting("LAUNCHER_KEY");
const runnerCommand = process.env.RUNNER_COMMAND;

// The runner gets the pass and the address of the Worker as its only inputs, plus PATH and the commit.
function runnerEnv(pass: string): Record<string, string> {
	const env: Record<string, string> = { PASS: pass, WORKER_URL: workerUrl };
	for (const name of ["PATH", "RUNNER_COMMIT"] as const) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
}

function spawnRunner(pass: string): RunnerChild {
	const env = runnerEnv(pass);
	// Each runner is the leader of a new process group. Thus a kill stops the runner and each of its children.
	const child =
		runnerCommand === undefined || runnerCommand === ""
			? spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
					cwd: RUNNER_DIR,
					env,
					stdio: "inherit",
					detached: true,
				})
			: spawn(runnerCommand, { shell: true, env, stdio: "inherit", detached: true });
	const exited = new Promise<number>((resolve) => {
		child.once("error", (error) => {
			log(`The runner did not start: ${error.message}`);
			resolve(1);
		});
		child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128 + 15)));
	});
	return {
		exited,
		kill() {
			if (child.pid === undefined) return;
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				// The process group is already gone.
			}
		},
	};
}

const launcher = startLauncher({ workerUrl, launcherKey, spawn: spawnRunner, log });
log("Started. It takes sandbox requests.");

// SIGTERM stops the take calls. The launcher waits for each runner and its report, then exits.
let signals = 0;
function onStop(): void {
	signals += 1;
	if (signals > 1) return;
	log("Stopping. The launcher waits for each runner.");
	void launcher.stop();
}
process.on("SIGTERM", onStop);
process.on("SIGINT", onStop);

try {
	await launcher.done;
	process.exitCode = 0;
} catch (error) {
	log(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
