// The Platform object: one Durable Object with the fixed name "platform" (docs/ARCHITECTURE.md, section 3.1).
// The logic of the admin commands is in the petra package. This class also keeps the list of sandboxes to start
// (section 3.6) in its own storage. The list is not the record: the record of an attempt is its row in attempts.

import { DurableObject } from "cloudflare:workers";
import { type AdminView, adminCommand, type Command, type ExitReport } from "@tensquads/contracts";
import { ports, type SandboxRequest, startSystem } from "@tensquads/core";
import { divide } from "@tensquads/costs";
import {
	type AdminAnswer,
	type OperationsRow,
	operationsRows,
	type PlatformObject,
	platformObject,
	platformWriter,
	sendNightJobs,
} from "@tensquads/petra";

import { type Env, errorResponse, platformConnections, readSettings } from "./env.js";
import { platformPlugins } from "./plugins/platform.js";

export const PLATFORM_NAME = "platform";

const ERROR_STATUS: Record<string, number> = { not_found: 404 };
const LIST_PREFIX = "sandbox/";
// The time between two reads of an empty list, during the take wait.
const POLL_MS = 100;

// One entry of the list. A request that a launcher took has a take time and is never given again.
interface ListEntry {
	request: SandboxRequest;
	putAt: number;
	takenAt?: number;
}

function answerStatus(answer: AdminAnswer): number {
	return "code" in answer ? (ERROR_STATUS[answer.code] ?? 400) : 200;
}

// One entry for each account, task and attempt.
const listKey = (accountId: string, taskId: string, attemptNo: number) =>
	`${LIST_PREFIX}${JSON.stringify([accountId, taskId, attemptNo])}`;

// The id of the command is made from the task and the attempt. A report that comes two times is one command.
const exitCommandId = (taskId: string, attemptNo: number) => `exit/${taskId}/${attemptNo}`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class PlatformDurableObject extends DurableObject<Env> {
	private started: Promise<PlatformObject> | undefined;
	private writer: ReturnType<typeof platformWriter> | undefined;

	private async sendToPetra(accountId: string, command: Command): Promise<void> {
		const petra = this.env.PETRA.get(this.env.PETRA.idFromName(accountId));
		const response = await petra.fetch("https://petra/command", {
			method: "POST",
			body: JSON.stringify({ command, origin: "system" }),
		});
		if (!response.ok) throw new Error(`Petra did not accept ${command.type}: ${response.status}`);
	}

	// At its start, the Platform object runs each "received" command again (section 6.2).
	private start(): Promise<PlatformObject> {
		this.started ??= (async () => {
			const system = await startSystem(platformPlugins(platformConnections(this.env)));
			this.writer = platformWriter(system.port(ports.database));
			const core = platformObject({
				writer: this.writer,
				sendToPetra: (accountId, command) => this.sendToPetra(accountId, command),
				divide,
			});
			await core.recover();
			return core;
		})();
		return this.started;
	}

	// The routes of the Platform object. Each route is one method.
	private readonly routes: Record<string, (request: Request, url: URL) => Promise<Response>> = {
		"/admin": (request) => this.admin(request),
		"/sandbox/put": async (request) => this.put((await request.json()) as SandboxRequest),
		"/sandbox/taken": async (_request, url) => this.taken(url),
		"/launcher/take": () => this.take(),
		"/launcher/report": async (request) => this.report((await request.json()) as ExitReport),
		"/night": async (request) => this.night((await request.json()) as { at: number }),
	};

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/views/")) return this.view(url.pathname.slice("/views/".length) as AdminView);
		const route = this.routes[url.pathname];
		return route ? route(request, url) : errorResponse(404, "not_found", "This call does not exist.");
	}

	// One view of the schema admin (section 7.6). The Worker checked the name. The operations view gets the stuck
	// tasks and the requests for a sandbox that no launcher took in the take time.
	private async view(name: AdminView): Promise<Response> {
		await this.start();
		const writer = this.writer;
		if (!writer) throw new Error("The Platform object has no writer.");
		const settings = readSettings(this.env);
		const rows = await writer.adminView(name, settings.creditValueMicros);
		if (name !== "operations") return Response.json({ view: name, rows });
		const entries = [...(await this.ctx.storage.list<ListEntry>({ prefix: LIST_PREFIX })).values()];
		const requests = entries.map((entry) => ({
			...entry.request,
			putAt: entry.putAt,
			...(entry.takenAt === undefined ? {} : { takenAt: entry.takenAt }),
		}));
		const limits = { attemptMaxMs: settings.attemptMaxMs, takeTimeMs: settings.takeTimeMs };
		const all = operationsRows(rows as unknown as OperationsRow[], requests, Date.now(), limits);
		return Response.json({ view: name, rows: all });
	}

	private async admin(request: Request): Promise<Response> {
		const core = await this.start();
		const body = (await request.json()) as { command: unknown; adminRef: string };
		const answer = await core.accept(adminCommand.parse(body.command), body.adminRef);
		return Response.json(answer, { status: answerStatus(answer) });
	}

	// A copy of a request changes nothing. A request that a launcher took stays taken.
	private async put(request: SandboxRequest): Promise<Response> {
		const key = listKey(request.accountId, request.taskId, request.attemptNo);
		if ((await this.ctx.storage.get<ListEntry>(key)) === undefined) {
			await this.ctx.storage.put(key, { request, putAt: Date.now() } satisfies ListEntry);
		}
		return Response.json({ ok: true });
	}

	private async taken(url: URL): Promise<Response> {
		const [accountId, taskId, attemptNo] = ["accountId", "taskId", "attemptNo"].map((name) =>
			url.searchParams.get(name),
		);
		const entry = await this.ctx.storage.get<ListEntry>(listKey(`${accountId}`, `${taskId}`, Number(attemptNo)));
		return Response.json({ takenAt: entry?.takenAt ?? null });
	}

	// Gives the oldest request that no launcher took, and marks it taken in the same turn of the object.
	private async takeNext(): Promise<SandboxRequest | undefined> {
		const entries = [...(await this.ctx.storage.list<ListEntry>({ prefix: LIST_PREFIX })).entries()];
		const open = entries.filter(([, entry]) => entry.takenAt === undefined).sort(([, a], [, b]) => a.putAt - b.putAt);
		const [first] = open;
		if (!first) return undefined;
		const [key, entry] = first;
		await this.ctx.storage.put(key, { ...entry, takenAt: Date.now() } satisfies ListEntry);
		return entry.request;
	}

	// When the list is empty, the call waits for the take wait (section 10), then answers 204.
	private async take(): Promise<Response> {
		const deadline = Date.now() + readSettings(this.env).takeWaitMs;
		for (;;) {
			const request = await this.takeNext();
			if (request) return Response.json({ request });
			if (Date.now() >= deadline) return new Response(null, { status: 204 });
			await wait(POLL_MS);
		}
	}

	// The hourly tick of the cron trigger (section 10.1). One night job for each account and each local date.
	private async night(tick: { at: number }): Promise<Response> {
		await this.start();
		const writer = this.writer;
		if (!writer) throw new Error("The Platform object has no writer.");
		await sendNightJobs({
			accounts: await writer.accounts(),
			now: tick.at,
			storage: this.ctx.storage,
			send: async (message) => void (await this.env.JOBS.send(message)),
		});
		return Response.json({ ok: true });
	}

	private async report(report: ExitReport): Promise<Response> {
		await this.sendToPetra(report.accountId, {
			type: "SandboxExited",
			commandId: exitCommandId(report.taskId, report.attemptNo),
			at: new Date().toISOString(),
			taskId: report.taskId,
			attempt: report.attemptNo,
			exitCode: report.exitCode,
		});
		return Response.json({ ok: true });
	}
}
