#!/usr/bin/env node

// The demo of task 04, against a running local platform (npm run dev:platform).
// The owner asks for a task of the test bot. The launcher starts a runner. In turn 2 the demo kills
// the runner, as a sandbox that stops. Petra starts attempt 2, and a new runner continues from the
// last copy of the journal. The result comes to the owner.
// The first argument is the URL of the Worker. The default is http://localhost:8787.
import { execFileSync } from "node:child_process";

import { request, setUpAccount } from "./demo-client.mjs";

const base = process.argv[2] ?? "http://localhost:8787";
const at = new Date().toISOString();
const taskId = `demo-${Date.now()}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const call = (path, token, body) => request(base, path, token, body);

await setUpAccount(call, at);
const { body: start } = await call("/v1/messages?after=0", "owner-a");
const after = start.messages.at(-1)?.seq ?? 0;

console.log(`== The owner sends: "Please read 3 files." (task ${taskId})`);
const sent = await call("/v1/commands", "owner-a", {
	type: "OwnerMessage",
	commandId: taskId,
	at,
	messageId: `m-${taskId}`,
	channel: "chat",
	text: "Please read 3 files.",
});
console.log(`POST /v1/commands -> ${sent.status} ${JSON.stringify(sent.body)}`);

let last = "";
let killed = false;
for (let i = 0; i < 600; i++) {
	const { status, body } = await call(`/v1/tasks/${taskId}`, "owner-a");
	if (status === 200) {
		const activity = body.activity;
		const line = `status ${body.status}${activity ? `, attempt ${activity.attemptNo}, turn ${activity.turnNo ?? "-"}, tool ${activity.toolCall?.tool ?? "-"}` : ""}`;
		if (line !== last) console.log(`GET /v1/tasks/${taskId} -> ${line}`);
		last = line;
		if (!killed && activity?.attemptNo === 1 && activity.turnNo >= 2) {
			// The runner of attempt 1 stops in the middle of a turn, as a sandbox that stops.
			const pids = execFileSync("pgrep", ["-f", "tsx src/main.ts"], { encoding: "utf8" }).trim().split("\n");
			for (const pid of pids) process.kill(Number(pid), "SIGKILL");
			console.log(
				`\n== The demo kills the runner of attempt 1 in turn ${activity.turnNo} (SIGKILL ${pids.join(", ")})\n`,
			);
			killed = true;
		}
		if (body.status === "done" || body.status === "failed") break;
	}
	await sleep(20);
}

const { body: list } = await call(`/v1/messages?after=${after}`, "owner-a");
console.log("\n== The messages of Petra to the owner");
for (const message of list.messages) {
	console.log(`seq ${message.seq} ${message.type}: ${message.text ?? message.summary}`);
}
