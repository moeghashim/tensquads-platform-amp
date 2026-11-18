import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type ToolRegistration,
	type Wake,
} from "@earendil-works/pi-durable";
import {
	type DurableObjectSqliteStorage,
	openDurableObjectSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { obj } from "@earendil-works/pi-schema";

import { type Complete, GATEWAY_MODEL, gatewayModels } from "./gateway-model.js";

// The loop of Petra in her Durable Object (ARCHITECTURE section 4.6).
// pi-durable keeps her conversation in the SQL storage of the Durable Object.

const context = BACKGROUND_CONTEXT;

export type { DurableObjectSqliteStorage };

export interface PetraTool {
	name: string;
	description: string;
	// Each tool writes by key, so a second run of it changes nothing.
	execute(input: Record<string, unknown>): Promise<string>;
}

export interface PetraLoopOptions {
	storage: DurableObjectSqliteStorage;
	tools: readonly PetraTool[];
	// The model port of Petra.
	complete: Complete;
	// pi-durable calls this when its next wake time changes. The Durable Object then sets its alarm again.
	wakeChanged?: (at: number | undefined) => void;
	now?: () => number;
}

export interface PetraLoop {
	// Gives one owner message to the conversation. The request id is the command id, so pi-durable takes it one time.
	submit(requestId: string, text: string): Promise<void>;
	// The shared alarm handler calls this. pi-durable continues its work.
	onWake(): void;
	// The next time pi-durable needs the Durable Object: now when work can run, or undefined when it needs nothing.
	nextWake(): number | undefined;
	close(): Promise<void>;
}

function nextTime(wake: Wake, now: () => number): number | undefined {
	return wake.active ? now() : wake.at;
}

function petraTool(tool: PetraTool): ToolRegistration {
	return defineTool({
		name: tool.name,
		description: tool.description,
		parameters: obj({}, { open: true }),
		replay: "safe",
		async execute(args) {
			return { output: [{ type: "text", text: await tool.execute(args as Record<string, unknown>) }] };
		},
	});
}

export async function openPetraLoop(options: PetraLoopOptions): Promise<PetraLoop> {
	const now = options.now ?? Date.now;
	const registry = createRegistry();
	registry.install(defineExtension({ name: "petra", tools: options.tools.map(petraTool) }));
	const harness = await Harness.open(
		await openDurableObjectSqliteStorage(options.storage),
		{
			models: gatewayModels(options.complete),
			registry,
			now,
			// With onWake, pi-durable arms no timer. The alarm of the Durable Object wakes it.
			onWake: (wake) => options.wakeChanged?.(nextTime(wake, now)),
		},
		context,
	);
	const root: Conversation = await harness.root(context, { agent: { model: GATEWAY_MODEL } });
	return {
		async submit(requestId, text) {
			await root.submit({ type: "input", content: text, requestId, whenBusy: "followUp" }, context);
		},
		onWake: () => harness.resume(),
		nextWake: () => nextTime(harness.wake(), now),
		close: () => harness.close(context),
	};
}
