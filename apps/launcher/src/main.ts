// The launcher. It starts one runner process for each sandbox request. It stands in for boat.dev (section 3.6).
// Settings: WORKER_URL and LAUNCHER_KEY. RUNNER_COMMAND is optional: a shell command that starts one runner.
import { spawn } from "node:child_process";

import { type RunnerChild, startLauncher } from "./launcher.js";
import { runnerSpawn } from "./runner-spawn.js";

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
// It starts in a new temp directory (requirement E6).
function spawnRunner(pass: string): RunnerChild {
	const how = runnerSpawn(pass, { workerUrl, env: process.env, runnerCommand });
	// Each runner is the leader of a new process group. Thus a kill stops the runner and each of its children.
	const child = spawn(how.command, how.args, {
		cwd: how.cwd,
		env: how.env,
		shell: how.shell,
		stdio: "inherit",
		detached: true,
	});
	child.once("exit", how.cleanUp);
	const exited = new Promise<number>((resolve) => {
		child.once("error", (error) => {
			how.cleanUp();
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
