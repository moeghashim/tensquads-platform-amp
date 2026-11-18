// The Platform Worker (docs/ARCHITECTURE.md, section 6.5). It holds no state and makes no decision.
// It checks who calls, then gives the call to the Petra of the account or to the Platform object.
import { exitReport, gatewayCall, messageListQuery, ownerCommand } from "@tensquads/contracts";
import { type Principal, ports, startSystem } from "@tensquads/core";
import { verifyPass } from "@tensquads/gateway";
import { type JobMessage, PETRA_HANDLES, PLATFORM_HANDLES } from "@tensquads/petra";

import { type Env, errorResponse, readSettings, SettingError, type Settings } from "./env.js";
import type { PetraObject } from "./petra-object.js";
import { PLATFORM_NAME } from "./platform-object.js";
import { platformPlugins } from "./plugins/platform.js";

export { PetraObject } from "./petra-object.js";
export { PlatformDurableObject } from "./platform-object.js";

// The Worker uses only the identity port. It starts the list with no database connection.
const system = startSystem(platformPlugins({}));

const bearer = (request: Request) => request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];

async function whoCalls(request: Request): Promise<Principal | undefined> {
	const token = bearer(request);
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
	return platformOf(env).fetch("https://platform/admin", {
		method: "POST",
		body: JSON.stringify({ command: body, adminRef: admin.adminId }),
	});
}

function adminCall(request: Request, env: Env, url: URL, admin: Admin): Promise<Response> | undefined {
	const isAdminCommand = `${request.method} ${url.pathname}` === "POST /v1/admin/commands";
	return isAdminCommand ? sendAdminCommand(request, env, admin) : undefined;
}

const platformOf = (env: Env) => env.PLATFORM.get(env.PLATFORM.idFromName(PLATFORM_NAME));

// The gateway (section 3.4). The Worker checks the signature and the end time of the pass. A call that fails gets a
// refusal with no detail and does not reach a Durable Object. The account comes from the pass, never from the body.
async function sendGatewayCall(request: Request, env: Env, settings: Settings): Promise<Response> {
	const token = bearer(request);
	const claims = token ? await verifyPass(token, settings.passKey, Date.now()) : undefined;
	if (!claims) return unauthorized();
	const call = gatewayCall.safeParse(await readJson(request));
	if (!call.success) return invalid();
	const petra = env.PETRA.get(env.PETRA.idFromName(claims.accountId));
	return petra.fetch("https://petra/gateway", { method: "POST", body: JSON.stringify({ claims, call: call.data }) });
}

const encoder = new TextEncoder();

// Compares the hashes of the two values in constant time, so the time does not tell a part of the key.
async function sameKey(given: string, key: string): Promise<boolean> {
	const [a, b] = await Promise.all(
		[given, key].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))),
	);
	return crypto.subtle.timingSafeEqual(a as ArrayBuffer, b as ArrayBuffer);
}

// The two calls of the launcher (section 3.6). The launcher proves who it is with the key of the launcher.
async function isLauncher(request: Request, settings: Settings): Promise<boolean> {
	const token = bearer(request);
	return token !== undefined && (await sameKey(token, settings.launcherKey));
}

async function launcherTake(request: Request, env: Env, settings: Settings): Promise<Response> {
	if (!(await isLauncher(request, settings))) return unauthorized();
	return platformOf(env).fetch("https://platform/launcher/take", { method: "POST" });
}

async function launcherReport(request: Request, env: Env, settings: Settings): Promise<Response> {
	if (!(await isLauncher(request, settings))) return unauthorized();
	const report = exitReport.safeParse(await readJson(request));
	if (!report.success) return invalid();
	return platformOf(env).fetch("https://platform/launcher/report", {
		method: "POST",
		body: JSON.stringify(report.data),
	});
}

// The calls of a runner and of the launcher. They do not use the identity port.
const MACHINE_ROUTES: Record<string, (request: Request, env: Env, settings: Settings) => Promise<Response>> = {
	"POST /v1/gateway": sendGatewayCall,
	"POST /v1/launcher/take": launcherTake,
	"POST /v1/launcher/report": launcherReport,
};

async function personCall(request: Request, env: Env, url: URL): Promise<Response> {
	const caller = await whoCalls(request);
	if (!caller) return unauthorized();
	const answer =
		caller.kind === "owner" ? await ownerCall(request, env, url, caller) : await adminCall(request, env, url, caller);
	return answer ?? errorResponse(404, "not_found", "This call does not exist.");
}

async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const settings = readSettings(env);
	const machine = MACHINE_ROUTES[`${request.method} ${url.pathname}`];
	return machine ? machine(request, env, settings) : personCall(request, env, url);
}

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return await route(request, env);
		} catch (error) {
			// The message of a setting names the setting and never its value (section 10).
			if (error instanceof SettingError) console.error(error.message);
			// The error stays inside. The answer has no stack trace and no data of an account (W4).
			return errorResponse(500, "internal", "An internal error occurred.");
		}
	},
	// The consumer of the queue "jobs". It gives each command to the Petra of its account.
	async queue(batch, env): Promise<void> {
		for (const message of batch.messages) {
			const { accountId, command } = message.body;
			const petra = env.PETRA.get(env.PETRA.idFromName(accountId));
			const response = await petra.fetch("https://petra/command", {
				method: "POST",
				body: JSON.stringify({ command, origin: "system" }),
			});
			if (response.ok) message.ack();
			else message.retry();
		}
	},
} satisfies ExportedHandler<Env, JobMessage>;
