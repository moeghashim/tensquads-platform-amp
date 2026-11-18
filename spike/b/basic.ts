// SP-B1, SP-B4 and the hook points: one conversation in Node, with a fake model and a fake tool.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj, str } from "@earendil-works/pi-schema";
import { rmSync } from "node:fs";
import { bridge } from "../shared/bridge.ts";
import { type Log, startCore } from "../shared/core.ts";

const context = BACKGROUND_CONTEXT;
const log: Log = { events: [] };
const { ctx, stop } = await startCore(log);
console.log(`SP-B1 cordis started in Node ${process.version}`);

const faux = fauxProvider({ provider: "faux", models: [{ id: "fake" }] });
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("lookup", { key: "refund-limit" }, { id: "call-1" }), { stopReason: "toolUse" }),
	fauxAssistantMessage(fauxText("This is a draft answer.")),
	fauxAssistantMessage(fauxText("The refund limit is $20.")),
]);

let runs = 0;
const lookup = defineTool({
	name: "lookup",
	description: "Look up one fact",
	parameters: obj({ key: str() }),
	execute: async (args) => {
		runs += 1;
		return { output: [{ type: "text", text: `${args.key} = $20` }] };
	},
});

const registry = createRegistry();
registry.install(defineExtension({ name: "tools", tools: [lookup] }));
registry.install(bridge(ctx));

const file = "/tmp/spike-b-basic.sqlite";
rmSync(file, { force: true });
const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "fake" } } });
const submission = await root.submit({ type: "input", content: "What is the refund limit?" }, context);
const settled = await submission.wait(context);
await harness.close(context);
await stop();

console.log("status:", settled.status, "tool runs:", runs, "model calls:", faux.state.callCount);
for (const event of log.events) console.log("  hook", event);
const ok =
	settled.status === "done" &&
	runs === 1 &&
	faux.state.callCount === 3 &&
	["model/before", "tool/before", "tool/after", "turn/end", "answer/check"].every((p) =>
		log.events.some((e) => e.startsWith(p)),
	) &&
	log.events.filter((e) => e.startsWith("answer/check")).length === 2;
console.log(ok ? "PASS hook points and SP-B4" : "FAIL");
process.exit(ok ? 0 : 1);
