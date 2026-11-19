// Calls to the Worker in the Workers runtime, as a client of the interface of section 6.5.

import { exports } from "cloudflare:workers";
import { TEST_TOKENS } from "@tensquads/adapters-test";

export const AT = "2026-11-18T10:00:00.000Z";
const BASE = "https://platform.test";

export function call(path: string, token: string | undefined, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	if (token) headers.set("authorization", `Bearer ${token}`);
	return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

export function post(path: string, token: string | undefined, body: unknown): Promise<Response> {
	return call(path, token, { method: "POST", body: JSON.stringify(body) });
}

// Makes the account of owner A, with credits, and adds owner A. The account id is the command id.
export async function setUpAccountA(): Promise<void> {
	const create = await post("/v1/admin/commands", TEST_TOKENS.superAdmin, {
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
	const owner = await post("/v1/admin/commands", TEST_TOKENS.superAdmin, {
		type: "AddOwner",
		commandId: "account-a/owner-a",
		at: AT,
		accountId: "account-a",
		identityRef: "owner-a",
	});
	if (!owner.ok) throw new Error(`AddOwner failed: ${await owner.text()}`);
}

export function ownerMessage(commandId: string, text: string) {
	return { type: "OwnerMessage", commandId, at: AT, messageId: `m-${commandId}`, channel: "chat", text };
}

// Petra handles the work list after she answers "accepted". The test waits for the list to reach a count.
export async function waitForMessages(token: string, after: number, count: number): Promise<{ seq: number }[]> {
	for (let i = 0; i < 100; i++) {
		const body = (await (await call(`/v1/messages?after=${after}`, token)).json()) as { messages: { seq: number }[] };
		if (body.messages.length >= count) return body.messages;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`The list did not get ${count} messages.`);
}

// Waits until the list has the given text and has the same messages in two reads, 300 ms apart.
// Petra handles the commands in sequence. When the list has the reply of the last command, it has the replies of all earlier commands.
export async function settledMessages(token: string, after: number, text: string): Promise<{ seq: number }[]> {
	let previous = "";
	for (let i = 0; i < 50; i++) {
		const body = (await (await call(`/v1/messages?after=${after}`, token)).json()) as { messages: { seq: number }[] };
		const listed = JSON.stringify(body.messages);
		if (listed.includes(text) && listed === previous) return body.messages;
		previous = listed;
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	throw new Error(`The list of messages did not become stable with the text "${text}".`);
}

// Opens the stream and collects each message that it sends.
export async function openStream(token: string, after: number): Promise<{ socket: WebSocket; received: unknown[] }> {
	const response = await call(`/v1/messages/stream?after=${after}`, token, { headers: { upgrade: "websocket" } });
	const socket = response.webSocket;
	if (!socket) throw new Error(`The stream did not open: ${response.status} ${await response.text()}`);
	const received: unknown[] = [];
	socket.addEventListener("message", (event) => {
		received.push(JSON.parse(event.data as string));
	});
	socket.accept();
	return { socket, received };
}

export async function until(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out: ${what}`);
}
