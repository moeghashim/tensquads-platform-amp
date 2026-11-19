// The full path on one machine (task 04): the local emulator of Cloudflare (wrangler dev), the real launcher, and
// real runner processes. A proxy sits between the runners and the Worker. It records each gateway call, and a rule
// can hold a call or kill the runner at an exact point. The database is the Postgres of DATABASE_URL.
// The tests of the full path (apps/launcher/test-e2e) and the runner of evals (task 11) both use it.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";

const ROOT = join(import.meta.dirname, "..", "..", "..");
export const PASS_KEY = "e2e-pass-key";
const LAUNCHER_KEY = "e2e-launcher-key";
export const SUPER_ADMIN = "super-admin";

export interface SeenCall {
	call: string;
	callNo: number;
	pass: string;
	status: number;
	answer: string;
	// The messages of a "model" call: the model request that the runner sent.
	messages?: { role: string; content: string }[];
}

export interface ProxiedCall {
	call: string;
	callNo: number;
	pass: string;
}

// A rule decides what the proxy does with a call before it goes to the Worker.
// "kill" kills the runner of the pass and never answers. "drop" answers ok and does not give the call to the
// Worker, as a copy of the journal that was lost. A promise holds the call until it resolves.
export type ProxyRule = (call: ProxiedCall) => "kill" | "drop" | Promise<void> | undefined;

// A rule on the answer of the Worker. "kill" kills the runner before the answer reaches it.
export type AnswerRule = (call: ProxiedCall, answer: string) => "kill" | undefined;

export interface FullPathOptions {
	// The settings of the Worker, for example a short silent time.
	vars?: Readonly<Record<string, string>>;
	// More settings of the launcher, for example RUNNER_COMMIT.
	launcherEnv?: Readonly<Record<string, string>>;
	// True: each runner writes its process id, so a rule can kill it. The runner then starts from a shell command.
	// False: the launcher starts each runner as it does in production.
	killable?: boolean;
}

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createNetServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

function loginUrl(databaseUrl: string, user: string, password: string): string {
	const url = new URL(databaseUrl);
	url.username = user;
	url.password = password;
	return url.toString();
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let body = "";
		request.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on("end", () => resolve(body));
	});
}

export async function waitFor<T>(what: string, check: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = await check();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out: ${what}`);
}

// The claims of a pass. The proxy does not check the signature.
export function claimsOf(pass: string): { accountId: string; taskId: string; attemptNo: number } {
	return JSON.parse(Buffer.from(pass.split(".")[0] ?? "", "base64url").toString()) as {
		accountId: string;
		taskId: string;
		attemptNo: number;
	};
}

export class LocalPath {
	readonly calls: SeenCall[] = [];
	rule: ProxyRule = () => undefined;
	answerRule: AnswerRule = () => undefined;
	// The log of the Worker. The test adapters of the payment and the channel write each send to it.
	workerLog = "";
	readonly killed: string[] = [];
	private worker?: ChildProcess;
	private launcher?: ChildProcess;
	private proxy?: Server;
	private workerUrl = "";
	proxyUrl = "";
	private readonly dir = mkdtempSync(join(tmpdir(), "tensquads-e2e-"));
	private readonly pidFile = join(this.dir, "runners");
	readonly db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

	constructor(private readonly options: FullPathOptions = {}) {}

	async start(): Promise<void> {
		const databaseUrl = process.env.DATABASE_URL;
		const password = process.env.DB_USER_PASSWORD;
		if (!databaseUrl || !password) throw new Error("The full path needs DATABASE_URL and DB_USER_PASSWORD.");
		spawnSync("npm", ["run", "build", "-w", "@tensquads/launcher"], { cwd: ROOT, stdio: "ignore" });
		writeFileSync(this.pidFile, "");
		const envFile = join(this.dir, "worker.env");
		writeFileSync(
			envFile,
			[
				`PETRA_DATABASE_URL=${loginUrl(databaseUrl, "ts_petra_login", password)}`,
				`PLATFORM_DATABASE_URL=${loginUrl(databaseUrl, "ts_platform_login", password)}`,
				`ADMIN_VIEWS_DATABASE_URL=${loginUrl(databaseUrl, "ts_admin_views_login", password)}`,
				`PASS_KEY=${PASS_KEY}`,
				`LAUNCHER_KEY=${LAUNCHER_KEY}`,
				"",
			].join("\n"),
		);
		const workerPort = await freePort();
		this.workerUrl = `http://127.0.0.1:${workerPort}`;
		const vars = { SILENT_MS: "30000", ...this.options.vars };
		this.worker = spawn(
			"npx",
			[
				"wrangler",
				"dev",
				"--port",
				String(workerPort),
				"--ip",
				"127.0.0.1",
				"--env-file",
				envFile,
				"--persist-to",
				join(this.dir, "state"),
				"--var",
				...Object.entries(vars).map(([name, value]) => `${name}:${value}`),
				"--show-interactive-dev-session=false",
			],
			{ cwd: join(ROOT, "apps", "platform"), stdio: ["ignore", "pipe", "pipe"], detached: true },
		);
		for (const stream of [this.worker.stdout, this.worker.stderr]) {
			stream?.on("data", (chunk: Buffer) => {
				this.workerLog += chunk.toString();
			});
		}
		await this.startProxy();
		await waitFor("the Worker starts", async () => {
			try {
				return (await fetch(`${this.workerUrl}/v1/messages`)).status === 401 ? true : undefined;
			} catch {
				return undefined;
			}
		});
		this.startLauncher();
	}

	private startLauncher(): void {
		const env: Record<string, string> = {
			PATH: process.env.PATH ?? "",
			WORKER_URL: this.proxyUrl,
			LAUNCHER_KEY,
			...this.options.launcherEnv,
		};
		// Each runner writes its process id and its pass, so the proxy can kill the runner of a pass.
		if (this.options.killable) {
			env.RUNNER_COMMAND = `cd ${join(ROOT, "apps", "runner")} && echo "$$ $PASS" >> ${this.pidFile} && exec node --import tsx src/main.ts`;
		}
		this.launcher = spawn("node", ["dist/main.js"], {
			cwd: join(ROOT, "apps", "launcher"),
			env,
			stdio: ["ignore", "ignore", "pipe"],
		});
		this.launcher.stderr?.on("data", (chunk: Buffer) => appendFileSync(join(this.dir, "launcher.log"), chunk));
	}

	private async startProxy(): Promise<void> {
		const port = await freePort();
		this.proxyUrl = `http://127.0.0.1:${port}`;
		this.proxy = createServer((request, response) => void this.relay(request, response));
		await new Promise<void>((resolve) => this.proxy?.listen(port, "127.0.0.1", resolve));
	}

	// Gives one call to the Worker, after the rule of the test. A gateway call is recorded with its answer.
	private async relay(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readBody(request);
		const pass = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
		const gatewayCall =
			request.url === "/v1/gateway" ? (JSON.parse(body) as { call: string; callNo: number }) : undefined;
		const rule = gatewayCall ? await this.applyRule({ ...gatewayCall, pass }) : "forward";
		if (rule === "killed") return;
		const answer =
			rule === "drop" ? { status: 200, answer: JSON.stringify({ ok: true }) } : await this.forward(request, body);
		if (!answer) {
			// The Worker stops at the end of the tests.
			response.writeHead(502).end();
			return;
		}
		if (gatewayCall) {
			this.calls.push({ ...gatewayCall, pass, ...answer });
			if (this.answerRule({ ...gatewayCall, pass }, answer.answer) === "kill") {
				this.kill(pass);
				return;
			}
		}
		response.writeHead(answer.status, { "content-type": "application/json" });
		response.end(answer.answer);
	}

	// "killed" when the rule killed the runner. The call then gets no answer.
	private async applyRule(call: ProxiedCall): Promise<"killed" | "drop" | "forward"> {
		const action = this.rule(call);
		if (action === "kill") {
			this.kill(call.pass);
			return "killed";
		}
		if (action === "drop") return "drop";
		await action;
		return "forward";
	}

	private async forward(
		request: IncomingMessage,
		body: string,
	): Promise<{ status: number; answer: string } | undefined> {
		try {
			const answer = await fetch(`${this.workerUrl}${request.url}`, {
				method: request.method,
				headers: { authorization: request.headers.authorization ?? "" },
				body: request.method === "POST" && body !== "" ? body : undefined,
			});
			return { status: answer.status, answer: await answer.text() };
		} catch {
			return undefined;
		}
	}

	// Kills the runner of a pass with SIGKILL, as a sandbox that stops. It needs the option killable.
	kill(pass: string): void {
		const line = readFileSync(this.pidFile, "utf8")
			.split("\n")
			.filter((item) => item.endsWith(` ${pass}`))
			.at(-1);
		const pid = Number(line?.split(" ")[0]);
		if (!pid) throw new Error("No runner has this pass.");
		this.killed.push(pass);
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			process.kill(pid, "SIGKILL");
		}
	}

	async api(path: string, token: string, body?: unknown): Promise<Response> {
		return fetch(`${this.workerUrl}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { authorization: `Bearer ${token}` },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}

	async gateway(pass: string, body: unknown): Promise<Response> {
		return fetch(`${this.workerUrl}/v1/gateway`, {
			method: "POST",
			headers: { authorization: `Bearer ${pass}` },
			body: JSON.stringify(body),
		});
	}

	// Sends one admin command as the super admin. A command that fails throws.
	async admin(command: Record<string, unknown>): Promise<void> {
		const answer = await this.api("/v1/admin/commands", SUPER_ADMIN, command);
		if (!answer.ok) throw new Error(`${String(command.type)} failed: ${await answer.text()}`);
	}

	async query<Row>(sql: string, params: unknown[] = []): Promise<Row[]> {
		return (await this.db.query(sql, params)).rows as Row[];
	}

	waitForTask(taskId: string, status: string, ms?: number): Promise<true> {
		return waitFor(
			`task ${taskId} has the status ${status}`,
			async () => {
				const [row] = await this.query<{ status: string }>("SELECT status FROM tasks WHERE id = $1", [taskId]);
				return row?.status === status ? true : undefined;
			},
			ms,
		);
	}

	waitForCall(what: string, check: (call: SeenCall) => boolean): Promise<SeenCall> {
		return waitFor(what, async () => this.calls.find(check));
	}

	async stop(): Promise<void> {
		this.launcher?.kill("SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, 500));
		this.launcher?.kill("SIGKILL");
		if (this.worker?.pid) {
			try {
				process.kill(-this.worker.pid, "SIGTERM");
			} catch {
				// The Worker is already gone.
			}
		}
		this.proxy?.close();
		await this.db.end();
	}
}
