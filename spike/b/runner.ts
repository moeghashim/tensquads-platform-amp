// The spike runner. It stands in for apps/runner in a sandbox.
// It runs one task with pi-durable on a local SQLite file. It sends a copy of the journal to the
// journal endpoint after each tool round and before each action. A new process continues from the
// last copy. Environment: TASK, SERVER, SCENARIO, KILL_AT, ATTEMPT, TURNS, REPLAY.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	defineTool,
	GenerationTask,
	Harness,
	hook,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { num, obj } from "@earendil-works/pi-schema";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { bridge } from "../shared/bridge.ts";
import { type Log, startCore } from "../shared/core.ts";

const env = process.env;
const TASK = env.TASK ?? "t1";
const SERVER = env.SERVER ?? "http://127.0.0.1:8790";
// The journal endpoint: the test Worker of part A when JOURNAL is set.
const JOURNAL = env.JOURNAL ?? SERVER;
const SCENARIO = env.SCENARIO ?? "basic";
const KILL_AT = env.KILL_AT ?? "";
const ATTEMPT = Number(env.ATTEMPT ?? "1");
const TURNS = Number(env.TURNS ?? "3");
const REPLAY = (env.REPLAY ?? "safe") as "safe" | "unsafe";
const SECRET = "SECRET-FACT-42";
const context: ChordContext = BACKGROUND_CONTEXT;
const file = `/tmp/spike-${TASK}-attempt-${ATTEMPT}.sqlite`;

function report(kind: string, data: unknown) {
	process.stdout.write(`RESULT ${JSON.stringify({ kind, attempt: ATTEMPT, ...((data as object) ?? {}) })}\n`);
}
function kill(point: string) {
	if (KILL_AT === point && ATTEMPT === 1) {
		report("killed", { point });
		process.kill(process.pid, "SIGKILL");
	}
}
async function post(path: string, body: unknown) {
	const response = await fetch(`${SERVER}${path}`, { method: "POST", body: JSON.stringify(body) });
	return (await response.json()) as Record<string, unknown>;
}

// A copy of the journal: VACUUM INTO gives one consistent file from a second connection.
let copyNo = 0;
async function sendCopy(label: string, extra: Record<string, unknown> = {}) {
	copyNo += 1;
	const started = performance.now();
	const target = `${file}.copy`;
	rmSync(target, { force: true });
	const db = new DatabaseSync(file);
	db.exec(`VACUUM INTO '${target}'`);
	db.close();
	const bytes = readFileSync(target);
	const response = await fetch(`${JOURNAL}/journal/${TASK}/${ATTEMPT}-${copyNo}`, {
		method: "PUT",
		body: bytes,
		headers: { "x-meta": JSON.stringify({ label, ...extra }) },
	});
	if (!response.ok) throw new Error(`journal copy failed: ${response.status}`);
	report("copy", { label, ...extra, bytes: bytes.length, ms: Math.round((performance.now() - started) * 10) / 10 });
}

// Load the last copy, if there is one.
rmSync(file, { force: true });
const last = await fetch(`${JOURNAL}/journal/${TASK}/latest`);
const resumed = last.status === 200;
if (resumed) writeFileSync(file, Buffer.from(await last.arrayBuffer()));

const log: Log = { events: [] };
const { ctx, stop } = await startCore(log);

// The fake model. Its answer depends only on the transcript, so a new process gets the same script.
const seen: { results: number; hasSecret: boolean; users: string[] }[] = [];
const faux = fauxProvider({ provider: "faux", models: [{ id: "fake" }] });
const models = createModels();
models.setProvider(faux.provider);
function textsOf(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => ("text" in part ? String(part.text) : "")).join("");
}
faux.setResponses(
	Array.from({ length: 200 }, () => (request: { messages: Message[] }) => {
		const results = request.messages.filter((m) => m.role === "toolResult");
		const users = request.messages.filter((m) => m.role === "user").map(textsOf);
		const all = request.messages.map(textsOf).join("\n");
		seen.push({ results: results.length, hasSecret: all.includes(SECRET), users });
		const n = results.length;
		const last = results.at(-1);
		const lastText = last === undefined ? "" : textsOf(last);
		if (SCENARIO === "turns") {
			if (n < TURNS) return fauxAssistantMessage(fauxToolCall("lookup", { n }), { stopReason: "toolUse" });
			return fauxAssistantMessage(fauxText(`done after ${n} tools`));
		}
		if (SCENARIO === "action") {
			const refunds = results.filter((m) => "toolName" in m && m.toolName === "refund").length;
			if (n === 0) return fauxAssistantMessage(fauxToolCall("lookup", { n: 0 }), { stopReason: "toolUse" });
			// After an "interrupted" error, a real model asks for the refund again, with a new id.
			if (refunds === 0 || (refunds === 1 && lastText.includes("interrupted") && n < 4))
				return fauxAssistantMessage(fauxToolCall("refund", { amount: 25 }), { stopReason: "toolUse" });
			return fauxAssistantMessage(fauxText(`refund result: ${lastText}`));
		}
		// basic: a slow tool, then a lookup, then the answer.
		if (n === 0) return fauxAssistantMessage(fauxToolCall("slow", { ms: 400 }), { stopReason: "toolUse" });
		if (n === 1) return fauxAssistantMessage(fauxToolCall("lookup", { n: 1 }), { stopReason: "toolUse" });
		return fauxAssistantMessage(fauxText("final answer"));
	}) as never,
);

const callIds: string[] = [];
const lookup = defineTool({
	name: "lookup",
	description: "Read one fact",
	parameters: obj({ n: num() }),
	replay: "safe",
	execute: async (args, api) => {
		callIds.push(api.callId);
		await post("/ran", { task: TASK, tool: "lookup", callId: api.callId, attempt: ATTEMPT });
		kill("mid-lookup");
		return { output: [{ type: "text", text: `fact ${args.n}` }] };
	},
});
const slow = defineTool({
	name: "slow",
	description: "A tool that takes time",
	parameters: obj({ ms: num() }),
	replay: "safe",
	execute: async (args, api) => {
		await post("/ran", { task: TASK, tool: "slow", callId: api.callId, attempt: ATTEMPT });
		if (SCENARIO === "basic" && env.STEER === "1" && ATTEMPT === 1) {
			// A message for the task arrives during the tool call.
			void root.submit(
				{ type: "input", content: "steer: use the new limit", whenBusy: "steer", requestId: "inbox-2" },
				context,
			);
		}
		kill("mid-tool");
		await new Promise((resolve) => setTimeout(resolve, args.ms));
		return { output: [{ type: "text", text: "slow done" }] };
	},
});
const refund = defineTool({
	name: "refund",
	description: "Refund money to a customer. An action tool.",
	parameters: obj({ amount: num() }),
	replay: REPLAY,
	execute: async (args, api) => {
		callIds.push(api.callId);
		const actionId = `${TASK}/${api.callId}`;
		await sendCopy("before-action", { callId: api.callId });
		kill("after-copy");
		const answer = await post("/action", { id: actionId, content: { amount: args.amount }, attempt: ATTEMPT });
		kill("after-answer");
		return { output: [{ type: "text", text: `refund ${answer.status} ${answer.ref}` }] };
	},
});

const registry = createRegistry();
registry.install(defineExtension({ name: "tools", tools: [lookup, slow, refund] }));
registry.install(bridge(ctx, { forget: () => [SECRET] }));
registry.install(
	defineExtension({
		name: "journal",
		hooks: [hook(GenerationTask, { afterTools: async () => sendCopy("turn") })],
	}),
);

const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "fake" } } });
report("start", { resumed });

// The messages of the task, each with its source reference as the request id.
const inbox = [{ requestId: "inbox-1", text: `Do the task. The customer note is ${SECRET}.` }];
if (env.EXTRA === "1") inbox.push({ requestId: "inbox-2", text: "steer: second message" });
const submissions = [];
for (const item of inbox) {
	submissions.push(
		await root.submit({ type: "input", content: item.text, requestId: item.requestId, whenBusy: "steer" }, context),
	);
}
if (resumed) harness.resume();
kill("before-wait");
const settled = await submissions[0]!.wait(context);
await harness.close(context);
await stop();
report("end", {
	status: settled.status,
	modelCalls: faux.state.callCount,
	seen,
	callIds,
	uniqueCallIds: new Set(callIds).size,
	events: log.events.length,
	journalBytes: existsSync(file) ? statSync(file).size : 0,
});
process.exit(0);
