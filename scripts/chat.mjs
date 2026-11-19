#!/usr/bin/env node

// A small chat with Petra on a Worker, from a terminal (task 12). It also starts the launcher on this machine, so a
// task of the test bot can run. Run: npm run chat.
// Settings: CHAT_URL (the Worker, for example the staging Worker), CHAT_TOKEN (the token of an owner) and
// LAUNCHER_KEY (the key of the launcher of that Worker). Each setting is read from the environment and never printed.
// Each line that you write goes to Petra as an owner message. Three lines are commands:
//   /approve and /reject decide the newest approval request. /answer <text> answers the newest question.
//   /quit stops the chat and the launcher.

import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

const ROOT = join(import.meta.dirname, "..");

function setting(name) {
	const value = process.env[name];
	if (!value) {
		console.error(`chat: the setting ${name} is missing.`);
		process.exit(1);
	}
	return value;
}

const url = setting("CHAT_URL");
const token = setting("CHAT_TOKEN");
const launcherKey = setting("LAUNCHER_KEY");

spawnSync("npm", ["run", "build", "-w", "@tensquads/launcher"], { cwd: ROOT, stdio: "ignore" });
const launcher = spawn("node", ["dist/main.js"], {
	cwd: join(ROOT, "apps", "launcher"),
	env: { PATH: process.env.PATH ?? "", WORKER_URL: url, LAUNCHER_KEY: launcherKey },
	stdio: "ignore",
});

async function call(path, body) {
	const response = await fetch(`${url}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	if (!response.ok) throw new Error(`The call ${path} failed with the status ${response.status}.`);
	return response.json();
}

let lastSeq = 0;
const seen = [];

// One line for each message to the owner. The text of a message comes first, then its ids.
function show(message) {
	const lines = {
		reply: () => message.text,
		question: () => `${message.text} ${message.options.length > 0 ? `(${message.options.join(" / ")})` : ""}`,
		approval_request: () => `Approval: ${message.content}. Write /approve or /reject.`,
		result: () => `Result of ${message.taskId}: ${message.summary}`,
		status: () => `Status of ${message.taskId}: ${message.step}`,
		action_not_confirmed: () => `Not confirmed: ${message.what}`,
		approval_decided: () => `You decided: ${message.decision}.`,
		question_answered: () => "Your answer is saved.",
	};
	console.log(`petra> ${(lines[message.type] ?? (() => JSON.stringify(message)))()}`);
}

async function poll() {
	const { messages } = await call(`/v1/messages?after=${lastSeq}`);
	for (const message of messages) {
		lastSeq = message.seq;
		seen.push(message);
		show(message);
	}
}

const newest = (type) => seen.filter((message) => message.type === type).at(-1);
const command = (body) => {
	const commandId = `chat-${Date.now().toString(36)}`;
	return call("/v1/commands", { commandId, at: new Date().toISOString(), ...body(commandId) });
};

// The decision on the newest approval request.
function decide(decision) {
	const request = newest("approval_request");
	if (!request) return console.log("chat: no approval request.");
	const { approvalId, contentHash } = request;
	return command(() => ({ type: "ApprovalDecision", approvalId, contentHash, decision }));
}

// The answer to the newest question.
function answer(text) {
	const question = newest("question");
	if (!question) return console.log("chat: no question.");
	return command(() => ({ type: "OwnerAnswer", questionId: question.questionId, text }));
}

function send(line) {
	if (line === "/approve" || line === "/reject") return decide(line.slice(1));
	if (line.startsWith("/answer ")) return answer(line.slice(8));
	return command((commandId) => ({ type: "OwnerMessage", messageId: commandId, channel: "chat", text: line }));
}

// The old messages are not shown again. Only the messages after the start of the chat.
lastSeq = (await call("/v1/messages?after=0")).messages.at(-1)?.seq ?? 0;
const timer = setInterval(() => poll().catch((error) => console.error(`chat: ${error.message}`)), 1000);
const input = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
input.prompt();
input.on("line", async (raw) => {
	const line = raw.trim();
	if (line === "/quit") return input.close();
	if (line !== "") await Promise.resolve(send(line)).catch((error) => console.error(`chat: ${error.message}`));
	input.prompt();
});
input.on("close", () => {
	clearInterval(timer);
	launcher.kill("SIGTERM");
});
