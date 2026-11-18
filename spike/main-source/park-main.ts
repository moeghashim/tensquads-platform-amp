// SP-B8 against the pi-durable source on main (not released). Copy this file into
// packages/durable of a clone of earendil-works/pi and run it with:
//   node --conditions=source --experimental-strip-types park-main.ts
// An action tool parks on a signal three times in one task. After each park the process saves a copy
// of the journal and stops. A new process opens the copy, delivers the signal and continues.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";
import { bool, num, obj } from "@earendil-works/pi-schema";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createRegistry, defineExtension, defineSignal, defineTool, Harness } from "./src/index.ts";
import { openNodeSqliteStorage } from "./src/storage/sqlite/node.ts";

const context = BACKGROUND_CONTEXT;
const Decision = defineSignal({ name: "spike.decision", version: 1, schema: obj({ allow: bool() }) });
const live = "/tmp/spike-b8-live.sqlite";
const copy = "/tmp/spike-b8-copy.sqlite";
const RESTART_LIMIT = 2;

async function runProcess(n: number): Promise<{ parked?: { taskId: string; key: string }; done?: string; executes: string[]; seen: string[] }> {
	const executes: string[] = [];
	const seen: string[] = [];
	let parked: { taskId: string; key: string } | undefined;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "fake" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(
		Array.from({ length: 20 }, () => (request: { messages: Message[] }) => {
			const results = request.messages.filter((m) => m.role === "toolResult");
			for (const r of results) seen.push(JSON.stringify(r.content));
			if (results.length < 3)
				return fauxAssistantMessage(fauxToolCall("refund", { amount: 10 + results.length }), { stopReason: "toolUse" });
			return fauxAssistantMessage(fauxText("all three refunds approved"));
		}) as never,
	);
	const refund = defineTool({
		name: "refund",
		description: "An action tool that waits for the owner",
		parameters: obj({ amount: num() }),
		replay: "safe",
		async execute(args, api, ctx) {
			executes.push(`${api.callId} wake=${JSON.stringify(api.wake ?? null)}`);
			const key = `decision-${api.callId}`;
			const state = await api.readSignal(Decision, key, ctx);
			if (state !== undefined && "value" in state) {
				return { output: [{ type: "text", text: `refund ${args.amount} ${state.value.allow ? "done" : "rejected"}` }] };
			}
			parked = { taskId: api.taskId, key };
			return { sleep: { signals: [Decision.key(key)] } };
		},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "tools", tools: [refund] }));
	if (existsSync(copy)) copyFileSync(copy, live);
	const harness = await Harness.open(await openNodeSqliteStorage(live), {
		models,
		registry,
		settings: { restartLimit: RESTART_LIMIT },
	} as never, context);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "fake" } } });
	const submission = await root.submit({ type: "input", content: "Do three refunds.", requestId: "task-1" }, context);
	const previous = process.env.PARKED;
	if (previous !== undefined) {
		const { taskId, key } = JSON.parse(previous) as { taskId: string; key: string };
		const delivered = await harness.signal(taskId as never, Decision, key, { allow: true }, context);
		executes.push(`signal ${key}: ${JSON.stringify(delivered)}`);
	}
	harness.resume();
	// Wait for the next park or the end of the run.
	const end = submission.wait(context).then((s) => s.status);
	for (let i = 0; i < 100 && parked === undefined; i++) {
		const status = await Promise.race([end, new Promise<undefined>((r) => setTimeout(r, 50))]);
		if (status !== undefined) {
			await harness.close(context);
			return { done: status, executes, seen };
		}
	}
	await new Promise((r) => setTimeout(r, 200)); // the park commit
	rmSync(copy, { force: true });
	const db = new DatabaseSync(live);
	db.exec(`VACUUM INTO '${copy}'`);
	db.close();
	console.log(`process ${n}: parked on ${parked?.key}; copy saved; the process stops`);
	return { parked, executes, seen };
}

// The driver: each step runs in a child process that exits after it saves the copy.
if (process.env.STEP === undefined) {
	rmSync(copy, { force: true });
	const { execFileSync } = await import("node:child_process");
	let parked: string | undefined;
	for (let step = 1; step <= 5; step++) {
		const out = execFileSync(process.execPath, ["--conditions=source", "--experimental-strip-types", import.meta.filename], {
			env: { ...process.env, STEP: String(step), ...(parked ? { PARKED: parked } : {}) },
			encoding: "utf8",
		});
		const result = JSON.parse(out.split("\n").filter((l) => l.startsWith("{")).at(-1)!);
		for (const line of out.split("\n").filter((l) => l.startsWith("process"))) console.log(line);
		for (const e of result.executes) console.log(`  execute ${e}`);
		if (result.done) {
			console.log(`process ${step}: run ${result.done}`);
			console.log(`results the model got: ${result.seen.slice(-3).join(" | ")}`);
			const wait = result.seen.some((s: string) => /wait|sleep|park/i.test(s));
			console.log(`the model got a "wait" result: ${wait}`);
			console.log(result.done === "done" && !wait ? "PASS SP-B8 on main" : "FAIL SP-B8 on main");
			break;
		}
		parked = JSON.stringify(result.parked);
	}
} else {
	const result = await runProcess(Number(process.env.STEP));
	console.log(JSON.stringify(result));
	process.exit(0);
}
