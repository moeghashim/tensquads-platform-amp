// The part A test Worker. One Durable Object (SpikePetra) runs a cordis core and a pi-durable harness
// on its own SQLite, shares its one alarm with a small work list, and accepts a WebSocket with
// hibernation. The Worker also serves the journal endpoint of part B and the database test.
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { Message, Model } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	defineTask,
	defineTool,
	Harness,
	type Wake,
} from "@earendil-works/pi-durable";
import {
	DurableObjectSqliteDatabase,
	openDurableObjectSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { num, obj } from "@earendil-works/pi-schema";
import { bridge } from "../shared/bridge.ts";
import { type Log, startCore } from "../shared/core.ts";
import { pgTest } from "./pg.ts";

interface Env {
	PETRA: DurableObjectNamespace<SpikePetra>;
	JOURNAL: R2Bucket;
	HYPERDRIVE?: Hyperdrive;
	PG_URL: string;
	FAKE_MODEL_URL: string;
}

const context = BACKGROUND_CONTEXT;
let hostDb: DurableObjectSqliteDatabase | undefined;
const SLOW_MS = 4000;

const Reminder = defineTask<{ at: number }, { phase: "wait" } | { phase: "deliver" }, null>({
	name: "spike.reminder",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: (task, runtime, ctx) => runtime.sleepUntil(task.input.at, { phase: "deliver" }, ctx),
		deliver: async (task, runtime, ctx) => {
			await hostDb?.run("INSERT INTO petra_wakes VALUES ('pi-durable', ?, ?)", task.input.at, Date.now());
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
		},
	},
	abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

export class SpikePetra extends DurableObject<Env> {
	#harness!: Harness;
	#db!: DurableObjectSqliteDatabase;
	#log: Log = { events: [] };
	#cordisStarted = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(async () => {
			const fallback = Date.now() + 60_000;
			const current = await ctx.storage.getAlarm();
			if (current === null || current > fallback) await ctx.storage.setAlarm(fallback);
			this.#db = new DurableObjectSqliteDatabase(ctx.storage);
			hostDb = this.#db;
			await this.#db.exec(
				"CREATE TABLE IF NOT EXISTS petra_runs (tool TEXT, call_id TEXT, at INTEGER);" +
					"CREATE TABLE IF NOT EXISTS petra_work (id INTEGER PRIMARY KEY, due INTEGER, done_at INTEGER);" +
					"CREATE TABLE IF NOT EXISTS petra_wakes (source TEXT, due INTEGER, at INTEGER);",
			);
			const { ctx: cordis } = await startCore(this.#log);
			this.#cordisStarted = true;

			const faux = fauxProvider({ provider: "faux", models: [{ id: "fake" }] });
			const models = createModels();
			models.setProvider(faux.provider);
			faux.setResponses(
				Array.from({ length: 50 }, () => (request: { messages: Message[] }) => {
					const results = request.messages.filter((m) => m.role === "toolResult");
					if (results.length === 0) {
						const unsafe = request.messages.some(
							(m) => m.role === "user" && JSON.stringify(m.content).includes("unsafe"),
						);
						return fauxAssistantMessage(fauxToolCall(unsafe ? "slow_unsafe" : "slow_safe", { ms: SLOW_MS }), {
							stopReason: "toolUse",
						});
					}
					return fauxAssistantMessage(fauxText(`answer after: ${JSON.stringify(results.at(-1)?.content)}`));
				}) as never,
			);
			const slow = (name: string, replay: "safe" | "unsafe") =>
				defineTool({
					name,
					description: "A tool that takes time",
					parameters: obj({ ms: num() }),
					replay,
					execute: async (args, api) => {
						await this.#db.run("INSERT INTO petra_runs VALUES (?, ?, ?)", name, api.callId, Date.now());
						await new Promise((resolve) => setTimeout(resolve, args.ms));
						return { output: [{ type: "text", text: `${name} done` }] };
					},
				});
			const registry = createRegistry();
			registry.install(
				defineExtension({ name: "tools", tools: [slow("slow_safe", "safe"), slow("slow_unsafe", "unsafe")], tasks: [Reminder] }),
			);
			registry.install(bridge(cordis));
			const storage = await openDurableObjectSqliteStorage(ctx.storage, { prefix: "pi_" });
			const onWake = (wake: Wake) => void this.#arm(wake).catch(() => ctx.abort("Alarm write failed"));
			this.#harness = await Harness.open(storage, { models, registry, onWake }, context);
			await this.#arm(this.#harness.wake());
			this.#harness.resume();
		});
	}

	// One alarm for both: the earliest of the pi-durable wake and the next item of the work list.
	async #arm(wake: Wake): Promise<void> {
		const heartbeat = wake.active ? Date.now() + 60_000 : undefined;
		const row = await this.#db.get<{ due: number | null }>("SELECT min(due) AS due FROM petra_work WHERE done_at IS NULL");
		const times = [heartbeat, wake.at, row?.due ?? undefined].filter((t): t is number => typeof t === "number");
		if (times.length === 0) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm(Math.min(...times));
	}

	override async alarm(): Promise<void> {
		const now = Date.now();
		const due = await this.#db.all<{ id: number; due: number }>(
			"SELECT id, due FROM petra_work WHERE done_at IS NULL AND due <= ?",
			now,
		);
		for (const item of due) {
			await this.#db.run("UPDATE petra_work SET done_at = ? WHERE id = ?", now, item.id);
			await this.#db.run("INSERT INTO petra_wakes VALUES ('work', ?, ?)", item.due, now);
			for (const socket of this.ctx.getWebSockets()) socket.send(JSON.stringify({ work: item.id, at: now }));
		}
		await this.#arm({ ...this.#harness.wake(), active: true });
		this.#harness.resume();
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const route = url.pathname.split("/").slice(3).join("/");
		if (route === "ws") {
			const pair = new WebSocketPair();
			this.ctx.acceptWebSocket(pair[1]);
			return new Response(null, { status: 101, webSocket: pair[0] });
		}
		if (route === "run") {
			const mode = url.searchParams.get("mode") ?? "safe";
			await this.#arm({ ...this.#harness.wake(), active: true });
			const root = await this.#harness.root(context, { agent: { model: { provider: "faux", modelId: "fake" } } });
			await root.submit({ type: "input", content: `run the ${mode} tool`, requestId: `run-${mode}` }, context);
			return Response.json({ ok: true });
		}
		if (route === "work") {
			const at = Date.now() + Number(url.searchParams.get("ms") ?? "1500");
			await this.#db.run("INSERT INTO petra_work (due) VALUES (?)", at);
			await this.#arm(this.#harness.wake());
			return Response.json({ due: at });
		}
		if (route === "sleep") {
			const at = Date.now() + Number(url.searchParams.get("ms") ?? "3000");
			await this.#arm({ ...this.#harness.wake(), active: true });
			const root = await this.#harness.root(context);
			const id = await root.commit((tx) => tx.createTask(Reminder, { at }, { ownership: { kind: "conversation", conversationId: root.id } } as never), context);
			return Response.json({ due: at, id });
		}
		if (route === "state") {
			const root = await this.#harness.root(context);
			const page = await root.entries({ order: "ascending" } as never, 100, undefined, context);
			const entries = page.items.map((e) => ({ kind: e.kind, text: JSON.stringify(e.model ?? "").slice(0, 160) }));
			return Response.json({
				cordis: this.#cordisStarted,
				hooks: this.#log.events,
				runs: await this.#db.all("SELECT tool, call_id, at FROM petra_runs"),
				wakes: await this.#db.all("SELECT source, due, at FROM petra_wakes"),
				work: await this.#db.all("SELECT * FROM petra_work"),
				wake: this.#harness.wake(),
				alarm: await this.ctx.storage.getAlarm(),
				sockets: this.ctx.getWebSockets().length,
				entries,
			});
		}
		if (route === "reset") {
			const root = await this.#harness.root(context);
			await root.reset(undefined, context);
			const rows = await this.#db.get<{ n: number }>("SELECT count(*) AS n FROM pi_entries");
			return Response.json({ entriesAfterReset: rows?.n });
		}
		if (route === "pg") return Response.json(await pgTest(this.env, "durable-object"));
		return Response.json({ code: "not_found" }, { status: 404 });
	}

	override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
		socket.send(`echo ${String(message)}`);
	}
}

// SP-A6: one model request through the model layer of pi, to a fake HTTP server.
async function modelTest(env: Env): Promise<unknown> {
	const model: Model<"openai-completions"> = {
		id: "fake-model",
		name: "fake",
		api: "openai-completions",
		provider: "fake",
		baseUrl: env.FAKE_MODEL_URL,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 8000,
		maxTokens: 100,
	};
	const stream = streamSimple(
		model,
		normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as never),
		{ apiKey: "not-a-real-key" },
	);
	const message = await stream.result();
	return { stopReason: message.stopReason, content: message.content, usage: message.usage, error: message.errorMessage };
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] === "cordis") {
			const log: Log = { events: [] };
			const { ctx, stop } = await startCore(log);
			ctx.emit("turn/end", { results: 0 });
			const refused = ctx.bail("answer/check", { text: "a draft" });
			await stop();
			return Response.json({ started: true, events: log.events, refused });
		}
		if (parts[0] === "do") {
			const stub = env.PETRA.get(env.PETRA.idFromName(parts[1] ?? "a"));
			return stub.fetch(request);
		}
		if (parts[0] === "model") return Response.json(await modelTest(env));
		if (parts[0] === "pg") return Response.json(await pgTest(env, "worker"));
		if (parts[0] === "journal") {
			const task = parts[1]!;
			if (request.method === "PUT") {
				const [attempt, no] = parts[2]!.split("-");
				await env.JOURNAL.put(`journal/${task}/${attempt!.padStart(6, "0")}-${no!.padStart(6, "0")}`, request.body, {
					customMetadata: { meta: request.headers.get("x-meta") ?? "{}" },
				});
				return Response.json({ ok: true });
			}
			if (request.method === "DELETE") {
				const list = await env.JOURNAL.list({ prefix: `journal/${task}/` });
				await env.JOURNAL.delete(list.objects.map((o) => o.key));
				return Response.json({ ok: true });
			}
			const list = await env.JOURNAL.list({ prefix: `journal/${task}/` });
			const newest = list.objects.map((o) => o.key).sort().at(-1);
			if (newest === undefined) return Response.json({ code: "not_found" }, { status: 404 });
			const object = await env.JOURNAL.get(newest);
			return new Response(object!.body);
		}
		return Response.json({ code: "not_found" }, { status: 404 });
	},
};
