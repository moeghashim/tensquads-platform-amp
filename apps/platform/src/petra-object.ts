// Petra: one Durable Object for each account. Its name is the account id (docs/ARCHITECTURE.md, section 8).
// The logic is in the petra package. This class gives it the storage, the plug-ins, the loop, the gateway and the stream.

import { DurableObject } from "cloudflare:workers";
import { checker } from "@tensquads/checker";
import { command as commandSchema, type GatewayCall, type OwnerMessage, type PassClaims } from "@tensquads/contracts";
import { ports, startSystem } from "@tensquads/core";
import { credits } from "@tensquads/credits";
import { gate } from "@tensquads/gate";
import { type Gateway, gateway, signPass } from "@tensquads/gateway";
import { openPetraLoop, type PetraLoop } from "@tensquads/loop";
import { cleanedFact, memory as makeMemory } from "@tensquads/memory";
import {
	accountWriter,
	actionWriter,
	CONVERSATION_KEY,
	type ConversationState,
	memoryWriter,
	nightJob,
	nightWriter,
	outbox,
	type Petra,
	petra,
	petraForgotten,
	petraTools,
	taskWork,
	taskWriter,
} from "@tensquads/petra";
import { trail } from "@tensquads/trail";

import { type Env, errorResponse, petraConnections, readSettings } from "./env.js";
import { PLATFORM_NAME } from "./platform-object.js";
import { petraPlugins } from "./plugins/petra.js";

// The state of one stream. It stays with the WebSocket when Petra hibernates.
interface StreamState {
	lastSeq: number;
	ready: boolean;
}

type Writer = ReturnType<typeof accountWriter>;
type Tasks = ReturnType<typeof taskWriter>;

interface Started {
	core: Petra;
	writer: Writer;
	tasks: Tasks;
	loop: PetraLoop;
	gw: Gateway;
}

// If the work stops, the alarm continues it.
const RETRY_MS = 1000;

// The earliest of the known times, or undefined when no time is known.
function earliest(times: readonly (number | undefined)[]): number | undefined {
	const known = times.filter((time): time is number => time !== undefined);
	return known.length === 0 ? undefined : Math.min(...known);
}

export class PetraObject extends DurableObject<Env> {
	private started: Promise<Started> | undefined;

	private platform() {
		return this.env.PLATFORM.get(this.env.PLATFORM.idFromName(PLATFORM_NAME));
	}

	// The time when a launcher took the request of the attempt, from the list of the Platform object.
	private async takenAt(accountId: string, taskId: string, attemptNo: number): Promise<number | undefined> {
		const query = new URLSearchParams({ accountId, taskId, attemptNo: String(attemptNo) });
		const response = await this.platform().fetch(`https://platform/sandbox/taken?${query}`);
		const body = (await response.json()) as { takenAt: number | null };
		return body.takenAt ?? undefined;
	}

	private start(): Promise<Started> {
		this.started ??= (async () => {
			const accountId = this.ctx.id.name;
			if (!accountId) throw new Error("Petra has no account id. Use idFromName(accountId).");
			const settings = readSettings(this.env);
			const bindings = {
				accountId,
				bucket: this.env.FILES,
				jobs: this.env.JOBS,
				platform: this.platform(),
				paymentHoldMs: settings.paymentHoldMs,
			};
			const system = await startSystem(petraPlugins(petraConnections(this.env), bindings));
			const database = system.port(ports.database);
			const writer = accountWriter(database, accountId);
			const objectStore = system.port(ports.objectStore);
			// Each trail row goes through the trail package: a large item goes to R2 (requirements T5 and T7).
			const rawTasks = taskWriter(database, accountId);
			const book = trail({ store: rawTasks, objectStore });
			const tasks: Tasks = { ...rawTasks, addTrail: book.add, trailRow: book.row };
			const storage = this.ctx.storage;
			const now = () => new Date().toISOString();
			const send = (message: OwnerMessage) => this.send(message);
			const out = outbox({ writer, storage, now, send, addTrail: tasks.addTrail });
			const actions = actionWriter(database, accountId);
			const queue = system.port(ports.queue);
			const model = system.port(ports.model);
			// The memory holds the rules. Petra writes its rows (requirement P2).
			const memory = makeMemory({ store: memoryWriter(database, accountId), tasks, tell: out.tell, model });
			// The gate calls the payment and the channel. A runner has no path to them (requirement G1).
			const actionGate = gate({
				accountId,
				store: actions,
				tasks,
				payment: system.port(ports.payment),
				channel: system.port(ports.channel),
				tell: (message) => out.tell(message),
				queue,
				toolLimitMs: settings.toolLimitMs,
				now,
			});
			const work = taskWork({
				accountId,
				tasks,
				outbox: out,
				storage,
				sandbox: system.port(ports.sandbox),
				queue,
				signPass: (claims) => signPass(claims, settings.passKey),
				takenAt: (taskId, attemptNo) => this.takenAt(accountId, taskId, attemptNo),
				credits: credits({
					store: { balance: writer.balance, chargeTask: tasks.chargeTask, giveBack: tasks.giveBack },
				}),
				settings,
				now,
				actions,
				checkAction: (commandId, actionId) => actionGate.checkJob(commandId, actionId),
				memory,
			});
			const tools = petraTools({ writer, tasks, work, outbox: out, now, memory });
			const loop = await openPetraLoop({
				storage,
				tools,
				complete: ({ messages }) => model.complete({ messages, tools: tools.map((tool) => tool.name) }),
				wakeChanged: (at) => void this.arm(at),
				// Petra removes the text of each forgotten fact from her own model requests (requirement M9). She keeps
				// the text of a deleted fact until her next new conversation (requirement M8).
				forgotten: () => petraForgotten(storage, () => memory.forgottenTexts()),
				// After a new conversation, Petra uses it (section 4.6).
				...(await this.conversationId()),
			});
			// The night job (section 10.1): the proposals, the deletions and the old trails (requirements M10, M13, T8).
			const night = nightJob({
				writer: nightWriter(database, accountId),
				memory,
				cancel: work.cancel,
				objectStore,
				storage,
				clean: cleanedFact,
				trail: book.night,
				now,
			});
			const core = petra({
				writer,
				storage,
				model,
				now,
				send,
				outbox: out,
				conversation: loop,
				work,
				nightJob: night.run,
				memory,
			});
			const gw = gateway({
				accountId,
				tasks,
				actions,
				gate: actionGate,
				objectStore,
				model,
				check: checker(system.port(ports.checkerModel)),
				storage,
				now,
				workerCommit: settings.workerCommit,
				settle: (claims, result) => work.afterResult(claims, result),
				noteCall: (claims) => work.noteCall(claims.taskId, claims.attemptNo),
			});
			await core.recover();
			return { core, writer, tasks, loop, gw };
		})();
		return this.started;
	}

	// The id of the conversation of Petra after a renew, or nothing for the root conversation.
	private async conversationId(): Promise<{ conversationId?: number }> {
		const state = await this.ctx.storage.get<ConversationState>(CONVERSATION_KEY);
		return state?.id === undefined ? {} : { conversationId: state.id };
	}

	// One alarm for pi-durable and the work list: the earlier of the two next times (section 4.6).
	private async arm(loopAt?: number): Promise<void> {
		const next = await this.nextWake(loopAt);
		if (next === undefined) return;
		const current = await this.ctx.storage.getAlarm();
		if (current === null || next < current) await this.ctx.storage.setAlarm(next);
	}

	private async nextWake(loopAt?: number): Promise<number | undefined> {
		if (!this.started) return loopAt;
		const { loop, core } = await this.started;
		const retryAt = (await core.pending()) ? Date.now() + RETRY_MS : undefined;
		return earliest([loopAt ?? loop.nextWake(), retryAt]);
	}

	// Sends a message on each stream that has its backlog. The message is in the database already.
	private send(message: OwnerMessage): void {
		for (const socket of this.ctx.getWebSockets()) {
			const state = socket.deserializeAttachment() as StreamState;
			if (state.ready && message.seq > state.lastSeq) {
				socket.send(JSON.stringify(message));
				socket.serializeAttachment({ ...state, lastSeq: message.seq });
			}
		}
	}

	// The routes of Petra. Each other path is /tasks/{taskId}.
	private readonly routes: Record<string, (request: Request, started: Started, after: number) => Promise<Response>> = {
		"/command": (request, started) => this.command(request, started),
		"/gateway": (request, started) => this.gatewayCall(request, started.gw),
		"/messages": async (_request, started, after) =>
			Response.json({ messages: await started.writer.ownerMessagesAfter(after) }),
		"/stream": (_request, started, after) => this.openStream(after, started.writer),
	};

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const started = await this.start();
		// Number(null) is 0. The Worker checked the value before.
		const after = Number(url.searchParams.get("after"));
		const route = this.routes[url.pathname];
		return route ? route(request, started, after) : this.task(url.pathname, started);
	}

	private async command(request: Request, { core, writer }: Started): Promise<Response> {
		const body = (await request.json()) as { command: unknown; origin: "owner" | "system"; identityRef?: string };
		// A command of an owner is valid only if owners has the identity for this account (section 6.1).
		if (body.origin === "owner" && !(await writer.isOwner(body.identityRef ?? ""))) {
			return errorResponse(403, "forbidden", "This owner is not an owner of the account.");
		}
		const command = commandSchema.parse(body.command);
		await core.accept(command, body.origin);
		await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
		this.ctx.waitUntil(core.work());
		return Response.json({ status: "accepted", commandId: command.commandId });
	}

	// The Worker verified the pass and parsed the call. Petra does her own checks (section 3.4).
	private async gatewayCall(request: Request, gw: Gateway): Promise<Response> {
		const { claims, call } = (await request.json()) as { claims: PassClaims; call: GatewayCall };
		const answer = await gw.call(claims, call);
		return Response.json(answer, { status: "refused" in answer ? 403 : 200 });
	}

	// The Worker sends only /tasks/{taskId} here. Each other path finds no task.
	// The activity comes from the trail rows of the task (requirement L7).
	private async task(pathname: string, { tasks }: Started): Promise<Response> {
		const taskId = decodeURIComponent(pathname.slice("/tasks/".length));
		const task = await tasks.task(taskId);
		if (!task) return errorResponse(404, "not_found", "The task does not exist.");
		const activity = await tasks.taskActivity(taskId, new Date().toISOString());
		return Response.json({ taskId, status: task.status, ...(activity ? { activity } : {}) });
	}

	// The stream (requirement W3). Petra accepts the WebSocket with hibernation, sends each message after
	// the number, then each new message. The list and the stream read the same rows.
	private async openStream(after: number, writer: Writer): Promise<Response> {
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.ctx.acceptWebSocket(server);
		let lastSeq = after;
		server.serializeAttachment({ lastSeq, ready: false } satisfies StreamState);
		for (const message of await writer.ownerMessagesAfter(after)) {
			server.send(JSON.stringify(message));
			lastSeq = message.seq;
		}
		server.serializeAttachment({ lastSeq, ready: true } satisfies StreamState);
		// A message that was written during the backlog read. Send it, if send() did not send it already.
		for (const message of await writer.ownerMessagesAfter(lastSeq)) {
			const state = server.deserializeAttachment() as StreamState;
			if (message.seq > state.lastSeq) {
				server.send(JSON.stringify(message));
				server.serializeAttachment({ ...state, lastSeq: message.seq });
			}
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	// The one alarm handler: pi-durable continues, the work list continues, then the alarm is set again.
	override async alarm(): Promise<void> {
		const { core, loop } = await this.start();
		loop.onWake();
		await core.recover();
		await core.work();
		await this.arm();
	}

	override async webSocketMessage(): Promise<void> {}

	override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
		socket.close(code, "The stream is closed.");
	}
}
