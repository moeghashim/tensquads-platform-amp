#!/usr/bin/env node

// The demo of task 03, against a running local platform (npm run dev:platform).
// A super admin makes an account and adds an owner. The owner sends a message.
// The reply of Petra comes on the stream and in the list.
// The first argument is the URL of the Worker. The default is http://localhost:8787.

const base = process.argv[2] ?? "http://localhost:8787";
const at = new Date().toISOString();
const run = Date.now();

async function call(path, token, body) {
	const response = await fetch(`${base}${path}`, {
		method: body ? "POST" : "GET",
		headers: { authorization: `Bearer ${token}` },
		body: body ? JSON.stringify(body) : undefined,
	});
	const answer = await response.json();
	console.log(`${body ? "POST" : "GET "} ${path} -> ${response.status} ${JSON.stringify(answer)}`);
	return answer;
}

console.log("== A super admin makes the account and adds the owner");
await call("/v1/admin/commands", "super-admin", {
	type: "CreateAccount",
	commandId: "account-a",
	at,
	name: "Cafe A",
	timeZone: "Asia/Riyadh",
	language: "en",
	modelProfile: "test",
	initialCredits: 100,
});
await call("/v1/admin/commands", "super-admin", {
	type: "AddOwner",
	commandId: "account-a/owner-a",
	at,
	accountId: "account-a",
	identityRef: "owner-a",
});

const { messages: before } = await call("/v1/messages?after=0", "owner-a");
const last = before.at(-1)?.seq ?? 0;

console.log(`\n== The owner opens the stream after seq ${last}`);
const stream = new WebSocket(`${base.replace(/^http/, "ws")}/v1/messages/stream?after=${last}`, {
	headers: { authorization: "Bearer owner-a" },
});
const reply = new Promise((resolve) => {
	stream.addEventListener("message", (event) => resolve(JSON.parse(event.data)));
});
await new Promise((resolve) => stream.addEventListener("open", resolve));

console.log("\n== The owner sends a message");
await call("/v1/commands", "owner-a", {
	type: "OwnerMessage",
	commandId: `demo-${run}`,
	at,
	messageId: `m-${run}`,
	channel: "chat",
	text: "Hello Petra",
});

console.log(`\n== On the stream: ${JSON.stringify(await reply)}`);
stream.close();

console.log("\n== In the list");
await call(`/v1/messages?after=${last}`, "owner-a");
