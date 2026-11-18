// The harness of the tests of the full path (task 04). It runs, on one machine:
// the local emulator of Cloudflare (wrangler dev), the real launcher, and real runner processes.
// A proxy sits between the runners and the Worker. It records each gateway call, and a test can hold
// a call or kill the runner at an exact point. The database is the Postgres of DATABASE_URL.
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
export const AT = "2026-11-18T10:00:00.000Z";

export interface SeenCall {
	call: string;
	callNo: number;
	pass: string;
	status: number;
	answer: string;
}

// A rule decides what the proxy does with a call before it goes to the Worker.
// "kill" kills the runner of the pass and never answers. A promise holds the call until it resolves.
export type ProxyRule = (call: { call: string; callNo: number; pass: string }) => "kill" | Promise<void> | undefined;

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

async function waitFor<T>(what: string, check: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = await check();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out: ${what}`);
}

export class FullPath {
	readonly calls: SeenCall[] = [];
	rule: ProxyRule = () => undefined;
	readonly killed: string[] = [];
	private worker?: ChildProcess;
	private launcher?: ChildProcess;
	private proxy?: Server;
	private workerUrl = "";
	proxyUrl = "";
	private readonly dir = mkdtempSync(join(tmpdir(), "tensquads-e2e-"));
	private readonly pidFile = join(this.dir, "runners");
	readonly db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

	async start(): Promise<void> {
		const databaseUrl = process.env.DATABASE_URL;
		const password = process.env.DB_USER_PASSWORD;
		if (!databaseUrl || !password)
			throw new Error("The tests of the full path need DATABASE_URL and DB_USER_PASSWORD.");
		await this.db.query("TRUNCATE accounts, admin_commands, unit_prices, shared_costs CASCADE");
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
				"SILENT_MS:30000",
				"--show-interactive-dev-session=false",
			],
			{ cwd: join(ROOT, "apps", "platform"), stdio: ["ignore", "ignore", "pipe"], detached: true },
		);
		await this.startProxy();
		await waitFor("the Worker starts", async () => {
			try {
				return (await fetch(`${this.workerUrl}/v1/messages`)).status === 401 ? true : undefined;
			} catch {
				return undefined;
			}
		});
		// Each runner writes its process id and its pass, so the proxy can kill the runner of a pass.
		const runner = `cd ${join(ROOT, "apps", "runner")} && echo "$$ $PASS" >> ${this.pidFile} && exec node --import tsx src/main.ts`;
		this.launcher = spawn("node", ["dist/main.js"], {
			cwd: join(ROOT, "apps", "launcher"),
			env: { PATH: process.env.PATH, WORKER_URL: this.proxyUrl, LAUNCHER_KEY, RUNNER_COMMAND: runner },
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
		if (gatewayCall && !(await this.applyRule({ ...gatewayCall, pass }))) return;
		const answer = await this.forward(request, body);
		if (!answer) {
			// The Worker stops at the end of the tests.
			response.writeHead(502).end();
			return;
		}
		if (gatewayCall) this.calls.push({ ...gatewayCall, pass, ...answer });
		response.writeHead(answer.status, { "content-type": "application/json" });
		response.end(answer.answer);
	}

	// Returns false when the rule killed the runner. The call then gets no answer.
	private async applyRule(call: { call: string; callNo: number; pass: string }): Promise<boolean> {
		const action = this.rule(call);
		if (action === "kill") {
			this.kill(call.pass);
			return false;
		}
		await action;
		return true;
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

	// Kills the runner of a pass with SIGKILL, as a sandbox that stops.
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

	// Starts one more runner by hand, with a pass, as a second sandbox for one attempt.
	runRunner(pass: string): Promise<number> {
		const child = spawn("node", ["--import", "tsx", "src/main.ts"], {
			cwd: join(ROOT, "apps", "runner"),
			env: { PATH: process.env.PATH, PASS: pass, WORKER_URL: this.proxyUrl },
			stdio: "ignore",
		});
		return new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
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

	async setUpAccount(): Promise<void> {
		const create = await this.api("/v1/admin/commands", "super-admin", {
			type: "CreateAccount",
			commandId: "account-a",
			at: AT,
			name: "Cafe A",
			timeZone: "Asia/Riyadh",
			language: "en",
			modelProfile: "test",
			initialCredits: 100,
		});
		if (!create.ok) throw new Error(`CreateAccount failed: ${await create.text()}`);
		const owner = await this.api("/v1/admin/commands", "super-admin", {
			type: "AddOwner",
			commandId: "account-a/owner-a",
			at: AT,
			accountId: "account-a",
			identityRef: "owner-a",
		});
		if (!owner.ok) throw new Error(`AddOwner failed: ${await owner.text()}`);
	}

	async send(command: Record<string, unknown>): Promise<void> {
		const answer = await this.api("/v1/commands", "owner-a", { at: AT, ...command });
		if (!answer.ok) throw new Error(`The command failed: ${await answer.text()}`);
	}

	ownerMessage(commandId: string, text: string): Promise<void> {
		return this.send({ type: "OwnerMessage", commandId, messageId: `m-${commandId}`, channel: "chat", text });
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

export { waitFor };
