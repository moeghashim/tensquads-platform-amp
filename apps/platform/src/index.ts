// The Platform Worker (docs/ARCHITECTURE.md, section 6.5). It holds no state and makes no decision.
// It checks who calls, then gives the call to the Petra of the account or to the Platform object.
import { messageListQuery, ownerCommand } from "@tensquads/contracts";
import { type Principal, ports, startSystem } from "@tensquads/core";
import { PETRA_HANDLES, PLATFORM_HANDLES } from "@tensquads/petra";

import { type Env, errorResponse } from "./env.js";
import type { PetraObject } from "./petra-object.js";
import { PLATFORM_NAME } from "./platform-object.js";
import { platformPlugins } from "./plugins/platform.js";

export { PetraObject } from "./petra-object.js";
export { PlatformDurableObject } from "./platform-object.js";

// The Worker uses only the identity port. It starts the list with no database connection.
const system = startSystem(platformPlugins({}));

async function whoCalls(request: Request): Promise<Principal | undefined> {
	const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
	return token ? (await system).port(ports.identity).whoIs(token) : undefined;
}

// A call with no valid sign-in gets a refusal with no detail.
const unauthorized = () => errorResponse(401, "unauthorized", "Unauthorized.");
const invalid = () => errorResponse(400, "invalid_request", "The request is not valid.");

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		return undefined;
	}
}

const notAvailable = () => errorResponse(400, "not_available", "This command is not available yet.");

// True when a handler exists in this task. The other commands get "not_available" before any write.
const handles = (list: readonly string[], type: unknown) => typeof type === "string" && list.includes(type);

type PetraStub = DurableObjectStub<PetraObject>;
type Owner = Extract<Principal, { kind: "owner" }>;
type Admin = Extract<Principal, { kind: "super_admin" }>;

async function sendCommand(request: Request, petra: PetraStub, owner: Owner): Promise<Response> {
	const parsed = ownerCommand.safeParse(await readJson(request));
	if (!parsed.success) return invalid();
	if (!handles(PETRA_HANDLES, parsed.data.type)) return notAvailable();
	return petra.fetch("https://petra/command", {
		method: "POST",
		body: JSON.stringify({ command: parsed.data, origin: "owner", identityRef: owner.ownerId }),
	});
}

function afterOf(url: URL): number | undefined {
	const query = messageListQuery.safeParse({ after: url.searchParams.get("after") ?? "0" });
	return query.success ? query.data.after : undefined;
}

async function readMessages(request: Request, petra: PetraStub, url: URL, stream: boolean): Promise<Response> {
	const after = afterOf(url);
	const upgrade = request.headers.get("upgrade") === "websocket";
	if (after === undefined || upgrade !== stream) return invalid();
	return petra.fetch(new Request(`https://petra${stream ? "/stream" : "/messages"}?after=${after}`, request));
}

interface OwnerRoute {
	method: string;
	path: RegExp;
	handle: (request: Request, petra: PetraStub, url: URL, owner: Owner) => Promise<Response>;
}

const OWNER_ROUTES: readonly OwnerRoute[] = [
	{
		method: "POST",
		path: /^\/v1\/commands$/,
		handle: (request, petra, _url, owner) => sendCommand(request, petra, owner),
	},
	{
		method: "GET",
		path: /^\/v1\/messages$/,
		handle: (request, petra, url) => readMessages(request, petra, url, false),
	},
	{
		method: "GET",
		path: /^\/v1\/messages\/stream$/,
		handle: (request, petra, url) => readMessages(request, petra, url, true),
	},
	{
		method: "GET",
		path: /^\/v1\/tasks\/[^/]+$/,
		handle: (_request, petra, url) => petra.fetch(`https://petra${url.pathname.slice(3)}`),
	},
];

function ownerCall(request: Request, env: Env, url: URL, owner: Owner): Promise<Response> | undefined {
	const route = OWNER_ROUTES.find((item) => item.method === request.method && item.path.test(url.pathname));
	// The account comes from the sign-in, never from the body (section 6.5).
	return route?.handle(request, env.PETRA.get(env.PETRA.idFromName(owner.accountId)), url, owner);
}

async function sendAdminCommand(request: Request, env: Env, admin: Admin): Promise<Response> {
	const body = await readJson(request);
	if (!handles(PLATFORM_HANDLES, (body as { type?: unknown } | undefined)?.type)) return notAvailable();
	const platform = env.PLATFORM.get(env.PLATFORM.idFromName(PLATFORM_NAME));
	return platform.fetch("https://platform/admin", {
		method: "POST",
		body: JSON.stringify({ command: body, adminRef: admin.adminId }),
	});
}

function adminCall(request: Request, env: Env, url: URL, admin: Admin): Promise<Response> | undefined {
	const isAdminCommand = `${request.method} ${url.pathname}` === "POST /v1/admin/commands";
	return isAdminCommand ? sendAdminCommand(request, env, admin) : undefined;
}

async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const caller = await whoCalls(request);
	if (!caller) return unauthorized();
	const answer =
		caller.kind === "owner" ? await ownerCall(request, env, url, caller) : await adminCall(request, env, url, caller);
	return answer ?? errorResponse(404, "not_found", "This call does not exist.");
}

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return await route(request, env);
		} catch {
			// The error stays inside. The answer has no stack trace and no data of an account (W4).
			return errorResponse(500, "internal", "An internal error occurred.");
		}
	},
} satisfies ExportedHandler<Env>;
