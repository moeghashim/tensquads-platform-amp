// The Platform object: one Durable Object with the fixed name "platform" (docs/ARCHITECTURE.md, section 3.1).
// The logic is in the petra package. This class gives it the plug-ins and the call to a Petra.

import { DurableObject } from "cloudflare:workers";
import { adminCommand, type Command } from "@tensquads/contracts";
import { ports, startSystem } from "@tensquads/core";
import { type AdminAnswer, type PlatformObject, platformObject, platformWriter } from "@tensquads/petra";

import { type Env, errorResponse, platformConnections } from "./env.js";
import { platformPlugins } from "./plugins/platform.js";

export const PLATFORM_NAME = "platform";

const ERROR_STATUS: Record<string, number> = { not_found: 404 };

function answerStatus(answer: AdminAnswer): number {
	return "code" in answer ? (ERROR_STATUS[answer.code] ?? 400) : 200;
}

export class PlatformDurableObject extends DurableObject<Env> {
	private started: Promise<PlatformObject> | undefined;

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
			const core = platformObject({
				writer: platformWriter(system.port(ports.database)),
				sendToPetra: (accountId, command) => this.sendToPetra(accountId, command),
			});
			await core.recover();
			return core;
		})();
		return this.started;
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/admin") return errorResponse(404, "not_found", "This call does not exist.");
		const core = await this.start();
		const body = (await request.json()) as { command: unknown; adminRef: string };
		const answer = await core.accept(adminCommand.parse(body.command), body.adminRef);
		return Response.json(answer, { status: answerStatus(answer) });
	}
}
