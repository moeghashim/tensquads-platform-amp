// One attempt of one task: the runner starts its plug-ins, runs the loop, and gives the exit code.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botPort } from "@tensquads/bot-test";
import { type PassClaims, passClaims } from "@tensquads/contracts";
import { startSystem } from "@tensquads/core";
import { linkPort } from "@tensquads/link";
import { RefusedError, runTask } from "@tensquads/loop";

import { type LinkSettings, runnerPlugins } from "./plugins.js";

// 0: the attempt ended with a result or a park. 1: an error. 3: the gateway refused a call (section 3.4).
const EXIT_DONE = 0;
export const EXIT_ERROR = 1;
const EXIT_REFUSED = 3;

// A setting is missing or not valid. The message names the setting and never its value (section 10).
export class SettingError extends Error {
	override name = "SettingError";
}

export interface RunnerSettings {
	pass: string;
	workerUrl: string;
}

export function readSettings(env: Readonly<Record<string, string | undefined>>): RunnerSettings {
	const pass = env.PASS;
	const workerUrl = env.WORKER_URL;
	if (pass === undefined || pass === "") {
		throw new SettingError("The setting PASS is missing.");
	}
	if (workerUrl === undefined || workerUrl === "") {
		throw new SettingError("The setting WORKER_URL is missing.");
	}
	if (!URL.canParse(workerUrl)) {
		throw new SettingError("The setting WORKER_URL is not a valid URL.");
	}
	return { pass, workerUrl };
}

// The runner reads the claims of the pass and does not check the signature. The Worker checks it (section 3.4).
export function decodePass(pass: string): PassClaims {
	const [body = ""] = pass.split(".");
	let json: unknown;
	try {
		json = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
	} catch {
		throw new SettingError("The setting PASS has no claims that the runner can read.");
	}
	const claims = passClaims.safeParse(json);
	if (!claims.success) {
		throw new SettingError("The setting PASS has no claims that the runner can read.");
	}
	return claims.data;
}

export interface RunInput extends Omit<LinkSettings, "runnerId"> {
	log: (line: string) => void;
}

export async function runAttempt(input: RunInput): Promise<number> {
	const { log, ...settings } = input;
	const claims = decodePass(settings.pass);
	const system = await startSystem(runnerPlugins({ ...settings, runnerId: randomUUID() }));
	const workDir = mkdtempSync(join(tmpdir(), "tensquads-runner-"));
	try {
		const bot = system.port(botPort);
		if (bot.definition.id !== claims.bot) {
			throw new Error(`The pass is for the bot "${claims.bot}". The runner has the bot "${bot.definition.id}".`);
		}
		const link = system.port(linkPort);
		// The runner needs the task type before the loop starts. The loop gets the same answer of start.
		const started = await link.start();
		const result = await runTask({
			bot: bot.definition,
			taskType: started.taskType,
			taskId: claims.taskId,
			attemptNo: claims.attemptNo,
			tools: bot.tools,
			link: { ...link, start: async () => started },
			system,
			workDir,
		});
		log(`The attempt ${claims.attemptNo} of the task ${claims.taskId} stopped with the name "${result.stop}".`);
		// An error is a failure of the attempt. The exit report tells Petra, and she starts a new attempt (L5).
		if (result.stop === "error") {
			return EXIT_ERROR;
		}
		// The loop sends a result that stands. Petra reads each other stop name from this call (requirement L2).
		if (result.stop !== "success") {
			await link.result(result);
		}
		return EXIT_DONE;
	} catch (error) {
		if (error instanceof RefusedError) {
			log(error.message);
			return EXIT_REFUSED;
		}
		throw error;
	} finally {
		await system.stop();
		rmSync(workDir, { recursive: true, force: true });
	}
}
