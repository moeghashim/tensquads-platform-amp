// The core of the launcher (ARCHITECTURE section 3.6). It takes each sandbox request from the Platform Worker,
// starts one runner for it, stops the runner at the end time of its pass, and reports the exit code.
// The fetch and the start of a process are inputs, so a test can run the launcher against a fake Worker.
import { setTimeout as wait } from "node:timers/promises";

// One sandbox request from the list of the Platform object.
export interface SandboxRequest {
	accountId: string;
	taskId: string;
	attemptNo: number;
	pass: string;
}

// A runner process that the launcher started.
export interface RunnerChild {
	// Resolves with the exit code when the process exits.
	exited: Promise<number>;
	kill(): void;
}

export type SpawnRunner = (pass: string) => RunnerChild;

export interface LauncherOptions {
	workerUrl: string;
	launcherKey: string;
	spawn: SpawnRunner;
	fetch?: typeof fetch;
	log?: (line: string) => void;
	// The time to wait after a failed call to the Worker.
	retryDelayMs?: number;
	now?: () => number;
}

export interface Launcher {
	// Stops taking requests. Resolves when each runner exited and its report is sent.
	stop(): Promise<void>;
	// Resolves when the launcher stopped. Rejects if the Worker refused the key of the launcher.
	done: Promise<void>;
}

// The exit code that the launcher reports when it cannot start a runner.
const EXIT_NOT_STARTED = 1;

const DEFAULT_RETRY_DELAY_MS = 1000;
const REPORT_TRIES = 5;

class KeyRefusedError extends Error {
	override name = "KeyRefusedError";
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseRequest(json: unknown): SandboxRequest | undefined {
	const request = isRecord(json) ? json.request : undefined;
	if (!isRecord(request)) return undefined;
	const { accountId, taskId, attemptNo, pass } = request;
	if (typeof accountId !== "string" || typeof taskId !== "string" || typeof pass !== "string") return undefined;
	if (typeof attemptNo !== "number" || !Number.isInteger(attemptNo)) return undefined;
	return { accountId, taskId, attemptNo, pass };
}

// The end time of the pass, from its claims. The launcher does not check the signature.
function passEndsAt(pass: string): number | undefined {
	const [body = ""] = pass.split(".");
	try {
		const claims: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
		const endsAt = isRecord(claims) ? claims.endsAt : undefined;
		return typeof endsAt === "number" && Number.isFinite(endsAt) ? endsAt : undefined;
	} catch {
		return undefined;
	}
}

export function startLauncher(options: LauncherOptions): Launcher {
	const send = options.fetch ?? fetch;
	const base = options.workerUrl.replace(/\/+$/, "");
	const log = options.log ?? (() => {});
	const now = options.now ?? Date.now;
	const retryDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	const headers = { authorization: `Bearer ${options.launcherKey}` };
	const running = new Set<Promise<void>>();
	const takes = new AbortController();
	let stopping = false;

	async function take(): Promise<SandboxRequest | undefined> {
		const response = await send(`${base}/v1/launcher/take`, { method: "POST", headers, signal: takes.signal });
		if (response.status === 204) {
			return undefined;
		}
		if (response.status === 401 || response.status === 403) {
			throw new KeyRefusedError("The Worker refused the setting LAUNCHER_KEY.");
		}
		if (response.status !== 200) {
			throw new Error(`The take call failed with the status ${response.status}.`);
		}
		const request = parseRequest(await response.json());
		if (request === undefined) {
			throw new Error("The answer of the take call has no valid request.");
		}
		return request;
	}

	async function report(request: SandboxRequest, exitCode: number): Promise<void> {
		const { accountId, taskId, attemptNo } = request;
		const body = JSON.stringify({ accountId, taskId, attemptNo, exitCode });
		for (let tries = 1; ; tries += 1) {
			try {
				const response = await send(`${base}/v1/launcher/report`, {
					method: "POST",
					headers: { ...headers, "content-type": "application/json" },
					body,
				});
				if (response.status === 200) return;
				throw new Error(`status ${response.status}`);
			} catch (error) {
				if (tries >= REPORT_TRIES) {
					log(`The report of task ${taskId} attempt ${attemptNo} failed: ${errorText(error)}`);
					return;
				}
				await wait(retryDelay);
			}
		}
	}

	async function runOne(request: SandboxRequest): Promise<void> {
		const label = `task ${request.taskId} attempt ${request.attemptNo}`;
		const endsAt = passEndsAt(request.pass);
		if (endsAt === undefined) {
			log(`The pass of ${label} has no end time. The launcher does not start a runner.`);
			await report(request, EXIT_NOT_STARTED);
			return;
		}
		const child = options.spawn(request.pass);
		log(`Started a runner for ${label}.`);
		// The launcher stops a runner at the end time of its pass (section 3.6).
		const timer = setTimeout(
			() => {
				log(`The pass of ${label} ended. The launcher stops its runner.`);
				child.kill();
			},
			Math.max(0, endsAt - now()),
		);
		let exitCode: number;
		try {
			exitCode = await child.exited;
		} finally {
			clearTimeout(timer);
		}
		log(`The runner for ${label} exited with the code ${exitCode}.`);
		await report(request, exitCode);
	}

	function launch(request: SandboxRequest): void {
		const work = runOne(request).catch((error: unknown) => log(`The runner failed: ${errorText(error)}`));
		running.add(work);
		void work.finally(() => running.delete(work));
	}

	async function loop(): Promise<void> {
		while (!stopping) {
			try {
				const request = await take();
				if (request !== undefined) launch(request);
			} catch (error) {
				if (stopping) break;
				if (error instanceof KeyRefusedError) {
					stopping = true;
					await Promise.all(running);
					throw error;
				}
				log(`The take call failed: ${errorText(error)}`);
				await wait(retryDelay);
			}
		}
		await Promise.all(running);
	}

	const done = loop();

	return {
		done,
		async stop() {
			stopping = true;
			takes.abort();
			await done.catch(() => {});
			// A runner can start between the abort and the end of the loop. Wait for each one.
			while (running.size > 0) {
				await Promise.all(running);
			}
		},
	};
}
