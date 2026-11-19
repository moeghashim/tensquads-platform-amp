// The Platform Worker (docs/ARCHITECTURE.md, section 6.5). It holds no state and makes no decision.
// It checks who calls, then gives the call to the Petra of the account or to the Platform object.
import {
	ADMIN_VIEWS,
	adminCommand,
	exitReport,
	gatewayCall,
	messageListQuery,
	ownerCommand,
} from "@tensquads/contracts";
import { type Principal, ports, startSystem } from "@tensquads/core";
import { verifyPass } from "@tensquads/gateway";
import { type JobMessage, PETRA_HANDLES } from "@tensquads/petra";

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
const notFound = () => errorResponse(404, "not_found", "This call does not exist.");
const forbidden = () => errorResponse(403, "forbidden", "This role cannot use this call.");

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
	// An owner cannot use an admin call (requirement S8).
	if (isAdminPath(request, url)) return Promise.resolve(forbidden());
	const route = OWNER_ROUTES.find((item) => item.method === request.method && item.path.test(url.pathname));
	// The account comes from the sign-in, never from the body (section 6.5).
	return route?.handle(request, env.PETRA.get(env.PETRA.idFromName(owner.accountId)), url, owner);
}

async function sendAdminCommand(request: Request, env: Env, admin: Admin): Promise<Response> {
	const parsed = adminCommand.safeParse(await readJson(request));
	if (!parsed.success) return invalid();
	return platformOf(env).fetch("https://platform/admin", {
		method: "POST",
		body: JSON.stringify({ command: parsed.data, adminRef: admin.adminId }),
	});
}

// One view of the schema admin, as rows (section 7.6). The Platform object reads it with the role of the views.
function readView(env: Env, name: string): Promise<Response> {
	if (!(ADMIN_VIEWS as readonly string[]).includes(name)) return Promise.resolve(notFound());
	return platformOf(env).fetch(`https://platform/views/${name}`);
}

// The one trail read of a super admin (section 6.5). Petra records the read, then gives the rows.
function readTrail(env: Env, url: URL, admin: Admin, accountId: string, taskId: string): Promise<Response> {
	const readId = url.searchParams.get("readId");
	if (!readId) return Promise.resolve(invalid());
	const petra = env.PETRA.get(env.PETRA.idFromName(accountId));
	return petra.fetch("https://petra/admin-trail", {
		method: "POST",
		body: JSON.stringify({ readId, adminRef: admin.adminId, taskId }),
	});
}

interface AdminRoute {
	method: string;
	path: RegExp;
	handle: (request: Request, env: Env, url: URL, admin: Admin, match: RegExpExecArray) => Promise<Response>;
}

// The admin calls of section 6.5. No other admin call exists (requirement S8).
const ADMIN_ROUTES: readonly AdminRoute[] = [
	{
		method: "POST",
		path: /^\/v1\/admin\/commands$/,
		handle: (request, env, _url, admin) => sendAdminCommand(request, env, admin),
	},
	{
		method: "GET",
		path: /^\/v1\/admin\/views\/([^/]+)$/,
		handle: (_request, env, _url, _admin, match) => readView(env, match[1] ?? ""),
	},
	{
		method: "GET",
		path: /^\/v1\/admin\/accounts\/([^/]+)\/tasks\/([^/]+)\/trail$/,
		handle: (_request, env, url, admin, match) =>
			readTrail(env, url, admin, decodeURIComponent(match[1] ?? ""), decodeURIComponent(match[2] ?? "")),
	},
];

function adminCall(request: Request, env: Env, url: URL, admin: Admin): Promise<Response> | undefined {
	// A super admin cannot use an owner call (requirement S8).
	if (isOwnerPath(request, url)) return Promise.resolve(forbidden());
	const route = ADMIN_ROUTES.find((item) => item.method === request.method && item.path.test(url.pathname));
	return route?.handle(request, env, url, admin, route.path.exec(url.pathname) as RegExpExecArray);
}

// True when the path is an owner call or an admin call, for the answer "forbidden" to the other role (S8).
const isOwnerPath = (request: Request, url: URL) =>
	OWNER_ROUTES.some((item) => item.method === request.method && item.path.test(url.pathname));
const isAdminPath = (request: Request, url: URL) =>
	ADMIN_ROUTES.some((item) => item.method === request.method && item.path.test(url.pathname));

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
	const answer = caller.kind === "owner" ? ownerCall(request, env, url, caller) : adminCall(request, env, url, caller);
	return (await answer) ?? notFound();
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
	// The cron trigger runs one time each hour. The Worker tells the Platform object (section 10.1).
	async scheduled(controller, env): Promise<void> {
		const response = await platformOf(env).fetch("https://platform/night", {
			method: "POST",
			body: JSON.stringify({ at: controller.scheduledTime }),
		});
		if (!response.ok) throw new Error(`The Platform object did not take the tick: ${response.status}`);
	},
} satisfies ExportedHandler<Env, JobMessage>;
