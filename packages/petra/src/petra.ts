// The logic of Petra for one account (docs/ARCHITECTURE.md, sections 4.6 and 7.3).
// The Durable Object class gives the storage, the model and the stream. This module has no Cloudflare import.
import type { Command, OwnerMessage } from "@tensquads/contracts";
import type { Model, ModelAnswer } from "@tensquads/core";

import type { AccountReader, AccountWriter, EventOrigin, OwnerInput } from "./account-writer.js";
import { customerRef } from "./customer.js";
import { FORGOTTEN_KEY, petraForgotten } from "./night.js";
import { outbox as makeOutbox, type Outbox, type OwnerMessageBody, type PetraStorage } from "./outbox.js";
import { READ_ONLY_TOOLS } from "./petra-tools.js";
import type { TaskWork } from "./task-work.js";

// The conversation of Petra (pi-durable). The request id makes a second submit of the same message do nothing.
export interface Conversation {
	submit(requestId: string, text: string): Promise<void>;
	// True when the conversation has no run and no input in its queue (section 4.6).
	idle?(): Promise<boolean>;
	// Starts a new conversation with the history as its first input. Returns the id of the new conversation.
	renew?(requestId: string, history: string | undefined): Promise<number>;
}

export interface PetraDeps {
	writer: AccountWriter & AccountReader;
	storage: PetraStorage;
	model: Model;
	now: () => string;
	// Sends a message on the open streams. Petra calls it only after the message is in the database.
	send: (message: OwnerMessage) => void;
	// The Durable Object gives one outbox to Petra, to the tools and to the task work, so one counter gives each seq.
	outbox?: Outbox;
	// With a conversation, the tools of Petra handle each owner message. Without it, Petra replies with the model.
	conversation?: Conversation;
	// The work on tasks and attempts. Without it, the task commands only get the status "done".
	work?: TaskWork;
	// The night job of the account: the proposals and the deletions (section 10.1). Petra renews her conversation after it.
	nightJob?: (localDate: string) => Promise<void>;
	// The memory commands of the owner (packages/memory). This package does not import it (requirement C2).
	memory?: CommandMemory;
	// The cost rows of Petra (packages/costs): her model calls in a command, and the shares of a shared cost.
	costs?: CommandCosts;
}

// The part of the costs that the commands use. Each row has a key, so a command that runs again adds no row.
export interface CommandCosts {
	modelCall(ref: { cause: string; taskId: string | null }, answer: ModelAnswer): Promise<void>;
	share(command: Extract<Command, { type: "AddCostShare" }>): Promise<void>;
}

// The part of the memory that the commands use. Each method answers the owner.
export interface CommandMemory {
	addCoreItem(item: { commandId: string; text: string; at: string }): Promise<unknown>;
	removeCoreItem(item: { commandId: string; itemId: string; at: string }): Promise<unknown>;
	forgetFact(forget: { commandId: string; factId: string; at: string }): Promise<unknown>;
	undoForget(undo: { commandId: string; factId: string; at: string }): Promise<unknown>;
	// The texts of the forgotten facts that are still in the database (requirement M8).
	forgottenTexts?(): Promise<readonly string[]>;
}

// The start time and the id of the conversation of Petra, in the storage of the Durable Object (section 7.3).
export const CONVERSATION_KEY = "petra_conversation";
export interface ConversationState {
	startedAt: string;
	id?: number;
}
// A new conversation each 90 days, when Petra is idle (section 7.7).
const CONVERSATION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const REMOVED = "[removed]";

const WORK_KEY = "petra_work";
// The marker of the storage. If it is not there at a start, Petra lost her storage (section 7.3).
const MARKER_KEY = "petra_marker";
// The number of owner messages in a new conversation (requirement L14).
const HISTORY_SIZE = 20;

// The command handlers of this task. Each later task adds its commands.
export const PETRA_HANDLES = [
	"OwnerMessage",
	"GrantCredits",
	"OwnerAnswer",
	"CancelTask",
	"SetRule",
	"ApprovalDecision",
	"AddCoreItem",
	"RemoveCoreItem",
	"ForgetFact",
	"UndoForget",
	"AddCostShare",
] as const;

// The text that Petra gives her conversation for one owner message. The model reads the command id and the
// channel from the first part, and gives them to the tool that it selects.
export function conversationText(commandId: string, channel: string, text: string): string {
	return `[command ${commandId} on ${channel}] ${text}`;
}

// The command of a model request of Petra: the newest owner message in her conversation, or undefined when the
// request has none. Petra uses its id for the key of the cost rows (section 7.1), and its channel and text for
// the input of her tools (task 12).
const COMMAND_TEXT = /^\[command (\S+) on (\S+)\] ([\s\S]*)$/;

export interface ConversationInput {
	commandId: string;
	channel: string;
	text: string;
	// True when a tool of Petra finished the command after the owner message: the tool had no error, and it is not a
	// tool that only reads. Then the event of the command is done.
	handled: boolean;
}

export function conversationInput(
	messages: readonly { role: string; content: string }[],
): ConversationInput | undefined {
	const isCommand = (message: { role: string; content: string }) =>
		message.role === "user" && COMMAND_TEXT.test(message.content);
	const index = messages.length - 1 - [...messages].reverse().findIndex(isCommand);
	const match = COMMAND_TEXT.exec(messages[index]?.content ?? "");
	if (!match) return undefined;
	const [, commandId = "", channel = "", text = ""] = match;
	const handled = messages.slice(index + 1).some(finishedCommand);
	return { commandId, channel, text, handled };
}

// A tool result is JSON text (packages/loop, gateway-model.ts). Only a tool that finished with no error marks the
// command done.
function finishedCommand(message: { role: string; content: string }): boolean {
	if (message.role !== "tool") return false;
	let result: { tool?: unknown; isError?: unknown };
	try {
		result = JSON.parse(message.content) as { tool?: unknown; isError?: unknown };
	} catch {
		return false;
	}
	return result.isError !== true && typeof result.tool === "string" && !READ_ONLY_TOOLS.has(result.tool);
}

export const conversationCommand = (messages: readonly { role: string; content: string }[]): string | undefined =>
	conversationInput(messages)?.commandId;

// The first input of a new conversation: the last messages of the owner. It has no command, so it starts no tool.
function historyText(inputs: readonly OwnerInput[]): string {
	return ["The earlier messages of the owner:", ...inputs.map((input) => `- ${input.text}`)].join("\n");
}

export interface Petra {
	// Writes the command to events, then puts it in the work list. Returns before the work is done (P4).
	accept(command: Command, origin: EventOrigin): Promise<void>;
	// Handles the work list one command at a time (P1).
	work(): Promise<void>;
	// True when the work list has a command.
	pending(): Promise<boolean>;
	// After a start: makes the work list again from the events that are "received" (section 7.3).
	// After a loss of the storage, it also makes a new conversation and sends the sandbox requests again (L14).
	recover(): Promise<void>;
}

// The check jobs of the "jobs" queue. The night job has no target.
async function runJob(deps: PetraDeps, command: Extract<Command, { type: "RunJob" }>): Promise<void> {
	if (command.job === "night") {
		if (command.localDate) await deps.nightJob?.(command.localDate);
		return renewConversation(deps, command.commandId);
	}
	const { work } = deps;
	if (!work || !command.targetId) return;
	if (command.job === "check task") await work.checkTask(command.commandId, command.targetId);
	if (command.job === "check action") await work.checkAction(command.commandId, command.targetId);
}

// The texts that Petra removes from her own model requests (requirement M8).
const forgottenOf = (deps: PetraDeps) =>
	petraForgotten(deps.storage, async () => (await deps.memory?.forgottenTexts?.()) ?? []);

// The last step of the night job (section 4.6). The conversation is older than 90 days and Petra is idle:
// she starts a new one from the messages in the database. The old pi_ rows stay (report of task 01, SP-A8).
async function renewConversation(deps: PetraDeps, commandId: string): Promise<void> {
	const { conversation, storage } = deps;
	if (!conversation?.renew || !conversation.idle) return;
	const now = deps.now();
	const state = await storage.get<ConversationState>(CONVERSATION_KEY);
	if (!state) return storage.put(CONVERSATION_KEY, { startedAt: now } satisfies ConversationState);
	if (Date.parse(now) - Date.parse(state.startedAt) <= CONVERSATION_DAYS * DAY_MS) return;
	if (!(await conversation.idle())) return;
	const texts = await forgottenOf(deps);
	const remove = (text: string) => texts.reduce((clean, item) => clean.replaceAll(item, REMOVED), text);
	const inputs = (await deps.writer.lastOwnerInputs(HISTORY_SIZE)).map((input) => ({
		...input,
		text: remove(input.text),
	}));
	const id = await conversation.renew(`renew/${commandId}`, inputs.length > 0 ? historyText(inputs) : undefined);
	await storage.put(CONVERSATION_KEY, { startedAt: now, id } satisfies ConversationState);
	// The new conversation has no text of a deleted fact, so Petra drops the kept texts (section 7.7).
	await storage.put(FORGOTTEN_KEY, []);
}

// The memory commands (section 6.1). Returns false for each other command.
async function handleMemory(memory: CommandMemory | undefined, command: Command): Promise<boolean> {
	const { commandId, at } = command;
	if (command.type === "AddCoreItem") await memory?.addCoreItem({ commandId, text: command.text, at });
	else if (command.type === "RemoveCoreItem") await memory?.removeCoreItem({ commandId, itemId: command.itemId, at });
	else if (command.type === "ForgetFact") await memory?.forgetFact({ commandId, factId: command.factId, at });
	else if (command.type === "UndoForget") await memory?.undoForget({ commandId, factId: command.factId, at });
	else return false;
	return true;
}

export function petra(deps: PetraDeps): Petra {
	const { writer, storage, conversation, work } = deps;
	const out = deps.outbox ?? makeOutbox(deps);
	let running: Promise<void> = Promise.resolve();

	async function workList(): Promise<Command[]> {
		return (await storage.get<Command[]>(WORK_KEY)) ?? [];
	}

	async function handleOwnerMessage(command: Extract<Command, { type: "OwnerMessage" }>): Promise<boolean> {
		const { commandId, channel, text, at } = command;
		const inbound = { direction: "in", channel, sender: "owner", type: "owner_message", body: { text }, at } as const;
		await out.write({ sourceRef: `cmd/${commandId}/in`, ...inbound });
		if (conversation) {
			// The tool that the model selects marks the command "done". Until then, a restart submits it again.
			await conversation.submit(commandId, conversationText(commandId, channel, text));
			return false;
		}
		const sourceRef = `cmd/${commandId}/reply`;
		// A command that runs again keeps its first reply. Petra does not ask the model again.
		if ((await writer.messageSeq(sourceRef)) !== undefined) return true;
		const answer = await deps.model.complete({ messages: [{ role: "user", content: text }], tools: [] });
		await deps.costs?.modelCall({ cause: `cmd/${commandId}`, taskId: null }, answer);
		await out.tell({ sourceRef, channel, body: { type: "reply", text: answer.text } });
		return true;
	}

	// An external event (section 7.8). The message of the customer gets the customer reference of our code.
	async function handleEvent(command: Extract<Command, { type: "ExternalEvent" }>): Promise<void> {
		const { commandId, source, sender, eventType, payload, at } = command;
		await out.write({
			sourceRef: `cmd/${commandId}/in`,
			direction: "in",
			channel: source,
			sender,
			type: eventType,
			body: payload,
			at,
			customerRef: await customerRef(writer.accountId, source, sender),
		});
	}

	// The message that tells a screen that Petra applied a decision or an answer of the owner (task 12).
	// It goes to the channel of the task. It has the key of the command, so a command that runs again
	// writes no second message. A command that changed nothing writes no message.
	async function tellHandled(work: TaskWork, command: Command): Promise<void> {
		let told: { channel: string; body: OwnerMessageBody } | undefined;
		if (command.type === "OwnerAnswer") {
			const applied = await work.ownerAnswer(command);
			const body = { type: "question_answered" as const, questionId: command.questionId };
			told = applied && { channel: applied.channel, body };
		} else if (command.type === "ApprovalDecision") {
			const applied = await work.approvalDecision(command);
			const body = { type: "approval_decided" as const, approvalId: command.approvalId };
			told = applied && { channel: applied.channel, body: { ...body, decision: applied.decision } };
		}
		if (told) await out.tell({ sourceRef: `cmd/${command.commandId}/handled`, ...told });
	}

	async function handleTask(command: Command): Promise<void> {
		if (command.type === "RunJob") return runJob(deps, command);
		if (!work) return;
		if (command.type === "CancelTask") await work.cancel(command.taskId, "owner");
		else if (command.type === "SandboxExited") await work.sandboxExited(command);
		else if (command.type === "ResendSandboxRequests") await work.resendRequests();
		else if (command.type === "SetRule") await work.setRule(command);
		else await tellHandled(work, command);
	}

	async function handle(command: Command): Promise<void> {
		let finished = true;
		if (command.type === "OwnerMessage") {
			finished = await handleOwnerMessage(command);
		} else if (command.type === "GrantCredits") {
			await writer.addGrant({
				sourceRef: `cmd/${command.commandId}/grant`,
				credits: command.credits,
				at: command.at,
			});
		} else if (command.type === "ExternalEvent") {
			await handleEvent(command);
		} else if (command.type === "AddCostShare") {
			// One cost row for the share of this account (section 7.6). Its key is the shared-cost id.
			await deps.costs?.share(command);
		} else if (!(await handleMemory(deps.memory, command))) {
			await handleTask(command);
		}
		if (finished) await writer.finishEvent(command.commandId);
	}

	async function drain(): Promise<void> {
		for (let list = await workList(); list.length > 0; list = await workList()) {
			const [first, ...rest] = list as [Command, ...Command[]];
			await handle(first);
			await storage.put(WORK_KEY, rest);
		}
	}

	async function enqueue(command: Command): Promise<void> {
		const list = await workList();
		if (!list.some((item) => item.commandId === command.commandId)) {
			await storage.put(WORK_KEY, [...list, command]);
		}
	}

	// Section 7.3: the work list and the seq counter come from the database. The conversation is new.
	async function rebuild(): Promise<void> {
		const maxSeq = await writer.maxSeq();
		if (maxSeq > 0) {
			const inputs = await writer.lastOwnerInputs(HISTORY_SIZE);
			if (conversation && inputs.length > 0) await conversation.submit(`history/${maxSeq}`, historyText(inputs));
			// Each open task continues. The request of each attempt with no start goes to the list again.
			await work?.resendRequests();
		}
		await storage.put(CONVERSATION_KEY, { startedAt: deps.now() } satisfies ConversationState);
		await storage.put(MARKER_KEY, true);
	}

	return {
		async accept(command, origin) {
			// Our code makes the customer reference of an external event. A model never sets it (section 7.8).
			const ref =
				command.type === "ExternalEvent"
					? await customerRef(writer.accountId, command.source, command.sender)
					: undefined;
			const status = await writer.receiveEvent({
				commandId: command.commandId,
				kind: command.type,
				payload: command,
				origin,
				at: command.at,
				...(ref ? { customerRef: ref } : {}),
			});
			if (status === "received") await enqueue(command);
		},
		work() {
			// One command at a time, also when two calls come at the same time.
			running = running.then(drain, drain);
			return running;
		},
		pending: async () => (await workList()).length > 0,
		async recover() {
			if ((await storage.get<boolean>(MARKER_KEY)) === undefined) await rebuild();
			for (const event of await writer.receivedEvents()) {
				await enqueue(event.payload as Command);
			}
		},
	};
}
