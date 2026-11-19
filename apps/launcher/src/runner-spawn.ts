// How the launcher starts one runner (section 3.6, requirement E6). The runner starts in a new temp directory,
// as in a sandbox. It gets the pass and the address of the Worker, plus PATH and the commit, and nothing more.
// Thus a bot under eval has no path to the cases and the graders in the repository.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER_MAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "runner", "src", "main.ts");

export interface RunnerSpawn {
	command: string;
	args: string[];
	// True: the command is a shell command (the setting RUNNER_COMMAND).
	shell: boolean;
	cwd: string;
	env: Record<string, string>;
	// Removes the directory of the runner. The launcher calls it after the runner exits.
	cleanUp(): void;
}

export interface SpawnSettings {
	workerUrl: string;
	// The environment of the launcher. The runner gets only PATH and RUNNER_COMMIT from it.
	env: Readonly<Record<string, string | undefined>>;
	// A shell command that starts one runner, or nothing for the runner of this repository.
	runnerCommand?: string | undefined;
}

export function runnerSpawn(pass: string, settings: SpawnSettings): RunnerSpawn {
	const env: Record<string, string> = { PASS: pass, WORKER_URL: settings.workerUrl };
	for (const name of ["PATH", "RUNNER_COMMIT"] as const) {
		const value = settings.env[name];
		if (value !== undefined) env[name] = value;
	}
	const cwd = mkdtempSync(join(tmpdir(), "tensquads-sandbox-"));
	const cleanUp = () => rmSync(cwd, { recursive: true, force: true });
	if (settings.runnerCommand !== undefined && settings.runnerCommand !== "") {
		return { command: settings.runnerCommand, args: [], shell: true, cwd, env, cleanUp };
	}
	// The loader of tsx has a full path, because the temp directory has no node_modules.
	const args = ["--import", import.meta.resolve("tsx"), RUNNER_MAIN];
	return { command: process.execPath, args, shell: false, cwd, env, cleanUp };
}
