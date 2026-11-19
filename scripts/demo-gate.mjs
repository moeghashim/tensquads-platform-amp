#!/usr/bin/env node

// The demo of task 05, against a running local platform (npm run dev:platform).
// The owner sets a refund limit of $20. A task asks for a refund of $60. The gate does not send it:
// Petra sends an approval request. The owner approves, a new attempt continues, and the refund goes out one time.
// The first argument is the URL of the Worker. The default is http://localhost:8787.
import { request, setUpAccount } from "./demo-client.mjs";

const base = process.argv[2] ?? "http://localhost:8787";
const at = new Date().toISOString();
const run = Date.now();
const taskId = `refund-${run}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (path, token, body) => request(base, path, token, body);

async function send(command) {
	const answer = await call("/v1/commands", "owner-a", { at, ...command });
	console.log(`POST /v1/commands ${command.type} -> ${answer.status} ${JSON.stringify(answer.body)}`);
}

// Waits for the first message of a type after a number, and prints each new message.
async function waitForMessage(after, type) {
	for (let i = 0; i < 600; i++) {
		const { body } = await call(`/v1/messages?after=${after}`, "owner-a");
		const found = body.messages.find((message) => message.type === type);
		if (found) return found;
		await sleep(50);
	}
	throw new Error(`No message of the type ${type} came.`);
}

await setUpAccount(call, at);
const { body: start } = await call("/v1/messages?after=0", "owner-a");
const after = start.messages.at(-1)?.seq ?? 0;

console.log("== The owner sets a rule: refunds of $20 or less need no approval");
await send({
	type: "SetRule",
	commandId: `rule-${run}`,
	rule: { kind: "money_limit", params: { maxAmount: 20_000_000 } },
});

console.log(`\n== The owner asks: "Please refund 60 to cust-1" (task ${taskId})`);
await send({
	type: "OwnerMessage",
	commandId: taskId,
	messageId: `m-${run}`,
	channel: "chat",
	text: "Please refund 60 to cust-1",
});

const approval = await waitForMessage(after, "approval_request");
console.log(`\n== Petra asks for an approval (seq ${approval.seq})`);
console.log(JSON.stringify(approval, null, 2));
let waiting = "";
for (let i = 0; i < 100 && waiting !== "waiting for the owner"; i++) {
	waiting = (await call(`/v1/tasks/${taskId}`, "owner-a")).body.status;
	await sleep(50);
}
console.log(`GET /v1/tasks/${taskId} -> status ${waiting}. No runner runs, and no refund went out.`);

console.log("\n== The owner approves the exact content (its hash)");
await send({
	type: "ApprovalDecision",
	commandId: `approve-${run}`,
	approvalId: approval.approvalId,
	decision: "approve",
	contentHash: approval.contentHash,
});

const result = await waitForMessage(approval.seq, "result");
const { body: done } = await call(`/v1/tasks/${taskId}`, "owner-a");
console.log(`GET /v1/tasks/${taskId} -> status ${done.status}, attempt ${done.activity?.attemptNo}`);
console.log(`\n== The result (seq ${result.seq}):\n${result.summary}`);
