// Petra: one Durable Object for each account. Its name is the account id (docs/ARCHITECTURE.md, section 8).
// The logic is in the petra package. This class gives it the storage, the plug-ins and the stream.

import { DurableObject } from "cloudflare:workers";
import { command as commandSchema, type OwnerMessage } from "@tensquads/contracts";
import { ports, type System, startSystem } from "@tensquads/core";
import { accountWriter, type Petra, petra } from "@tensquads/petra";

import { type Env, errorResponse, petraConnections } from "./env.js";
import { petraPlugins } from "./plugins/petra.js";

// The state of one stream. It stays with the WebSocket when Petra hibernates.
interface StreamState {
	lastSeq: number;
	ready: boolean;
}

type Writer = ReturnType<typeof accountWriter>;

// If the work stops, the alarm continues it.
const RETRY_MS = 1000;

export class PetraObject extends DurableObject<Env> {
	private started: Promise<{ system: System; core: Petra; writer: Writer }> | undefined;

	private start() {
		this.started ??= (async () => {
			const accountId = this.ctx.id.name;
			if (!accountId) throw new Error("Petra has no account id. Use idFromName(accountId).");
			const system = await startSystem(petraPlugins(petraConnections(this.env)));
			const writer = accountWriter(system.port(ports.database), accountId);
			const core = petra({
				writer,
				storage: this.ctx.storage,
				model: system.port(ports.model),
				now: () => new Date().toISOString(),
				send: (message) => this.send(message),
			});
			await core.recover();
			return { system, core, writer };
		})();
		return this.started;
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

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const started = await this.start();
		// Number(null) is 0. The Worker checked the value before.
		const after = Number(url.searchParams.get("after"));
		switch (url.pathname) {
			case "/command":
				return this.command(request, started.core, started.writer);
			case "/messages":
				return Response.json({ messages: await started.writer.ownerMessagesAfter(after) });
			case "/stream":
				return this.openStream(after, started.writer);
			default:
				return this.task(url.pathname, started.writer);
		}
	}

	private async command(request: Request, core: Petra, writer: Writer): Promise<Response> {
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

	// The Worker sends only /tasks/{taskId} here. Each other path finds no task.
	private async task(pathname: string, writer: Writer): Promise<Response> {
		const taskId = decodeURIComponent(pathname.slice("/tasks/".length));
		const status = await writer.taskStatus(taskId);
		return status ? Response.json({ taskId, status }) : errorResponse(404, "not_found", "The task does not exist.");
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

	override async alarm(): Promise<void> {
		const { core } = await this.start();
		await core.recover();
		await core.work();
	}

	override async webSocketMessage(): Promise<void> {}

	override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
		socket.close(code, "The stream is closed.");
	}
}
