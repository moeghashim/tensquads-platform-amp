#!/usr/bin/env node

// The demo of task 10, against a running local platform (npm run dev:platform).
// The super admin sets the unit prices. Account A runs two tasks: one reads a file, one refunds $15 under a
// rule of $20. Then the super admin reads the view "account" for account A. The demo reads only through the API.
// The first argument is the URL of the Worker. The default is http://localhost:8787.
import { request, sendCommand, setUpAccount, waitForTaskEnd } from "./demo-client.mjs";

const base = process.argv[2] ?? "http://localhost:8787";
const at = new Date().toISOString();
const run = Date.now();
const call = (path, token, body) => request(base, path, token, body);

// The prices are in millionths of a US dollar for one unit. A price for "1M ..." or "1k seconds" is for one
// million units.
const PRICES = [
	{ provider: "test", model: "rule", unit: "1M input tokens", price: 3_000_000 },
	{ provider: "test", model: "rule", unit: "1M output tokens", price: 15_000_000 },
	{ provider: "test", model: "rule-check", unit: "call", price: 200 },
	{ provider: "test", model: "fixed", unit: "call", price: 100 },
	// The sandbox counts milliseconds. Its price is for 1000 seconds: 50 millionths of a US dollar for each second.
	{ provider: "launcher", model: "", unit: "1k seconds", price: 50_000 },
	{ provider: "test-payment", model: "", unit: "call", price: 300_000 },
];

await setUpAccount(call, at);

console.log("== The super admin sets the unit prices (SetUnitPrice)");
for (const [index, price] of PRICES.entries()) {
	const answer = await call("/v1/admin/commands", "super-admin", {
		type: "SetUnitPrice",
		commandId: `price-${run}-${index}`,
		at,
		startsAt: "2026-01-01T00:00:00.000Z",
		...price,
	});
	console.log(`${price.provider}/${price.model || "-"}/${price.unit} = ${price.price} -> ${answer.status}`);
}

console.log("\n== The owner sets a rule: refunds of $20 or less need no approval");
await sendCommand(call, {
	type: "SetRule",
	commandId: `rule-${run}`,
	rule: { kind: "money_limit", params: { maxAmount: 20_000_000 } },
});

const tasks = [
	[`read-${run}`, "Please read 1 file."],
	[`refund-${run}`, "Please refund 15 to cust-1"],
];
for (const [taskId, text] of tasks) {
	console.log(`\n== The owner sends: "${text}" (task ${taskId})`);
	await sendCommand(call, {
		type: "OwnerMessage",
		commandId: taskId,
		messageId: `m-${taskId}`,
		channel: "chat",
		text,
	});
	await waitForTaskEnd(call, taskId);
	const { body } = await call(`/v1/tasks/${taskId}`, "owner-a");
	console.log(`GET /v1/tasks/${taskId} -> ${body.status}`);
}

console.log("\n== GET /v1/admin/views/account as the super admin (millionths of a US dollar)");
const { status, body } = await call("/v1/admin/views/account", "super-admin");
const row = body.rows?.find((item) => item.account_id === "account-a");
console.log(`status ${status}`);
console.log(JSON.stringify(row, null, 2));
