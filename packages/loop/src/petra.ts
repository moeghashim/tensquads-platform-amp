import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type Conversation,
	type ConversationId,
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
import { removeModelTexts } from "./messages.js";

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
	// The texts of the forgotten facts. Petra removes them before each of her model requests (requirement M9).
	forgotten?: () => Promise<readonly string[]>;
	// The id of the conversation of Petra after a renew. Without it, the loop uses the root conversation.
	conversationId?: number;
}

export interface PetraLoop {
	// Gives one owner message to the conversation. The request id is the command id, so pi-durable takes it one time.
	submit(requestId: string, text: string): Promise<void>;
	// The shared alarm handler calls this. pi-durable continues its work.
	onWake(): void;
	// The next time pi-durable needs the Durable Object: now when work can run, or undefined when it needs nothing.
	nextWake(): number | undefined;
	// True when Petra has no task of pi-durable that runs or waits, and no submission that is not settled.
	idle(): Promise<boolean>;
	// Starts a new conversation and uses it from now on (ARCHITECTURE section 4.6, report of task 01, SP-A8).
	// pi-durable 1.5.2 has no call that deletes a conversation, so the old pi_ rows stay.
	// The history is the first input of the new conversation. Returns the id of the new conversation.
	renew(requestId: string, history: string | undefined): Promise<number>;
	// The id of the conversation in use.
	conversationId(): number;
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
			models: gatewayModels(async (request) => {
				const texts = (await options.forgotten?.()) ?? [];
				return options.complete({ ...request, messages: removeModelTexts(request.messages, texts) });
			}),
			registry,
			now,
			// With onWake, pi-durable arms no timer. The alarm of the Durable Object wakes it.
			onWake: (wake) => options.wakeChanged?.(nextTime(wake, now)),
		},
		context,
	);
	const agent = { model: GATEWAY_MODEL };
	const saved =
		options.conversationId === undefined
			? undefined
			: await harness.conversation(options.conversationId as ConversationId, context);
	let current: Conversation = saved ?? (await harness.root(context, { agent }));
	const submit = async (requestId: string, text: string) => {
		await current.submit({ type: "input", content: text, requestId, whenBusy: "followUp" }, context);
	};
	return {
		submit,
		async idle() {
			const inspection = await harness.inspect(context);
			return inspection.tasks.length === 0 && inspection.submissions.length === 0;
		},
		async renew(requestId, history) {
			current = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
			if (history !== undefined) await submit(requestId, history);
			return current.id;
		},
		conversationId: () => current.id,
		onWake: () => harness.resume(),
		nextWake: () => nextTime(harness.wake(), now),
		close: () => harness.close(context),
	};
}
