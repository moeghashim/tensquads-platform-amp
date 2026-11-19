// The logic of Petra for one account (docs/ARCHITECTURE.md, sections 4.6 and 7.3).
// The Durable Object class gives the storage, the model and the stream. This module has no Cloudflare import.
import type { Command, OwnerMessage } from "@tensquads/contracts";
import type { Model } from "@tensquads/core";

import type { AccountReader, AccountWriter, EventOrigin, OwnerInput } from "./account-writer.js";
import { outbox as makeOutbox, type Outbox, type PetraStorage } from "./outbox.js";
import type { TaskWork } from "./task-work.js";

// The conversation of Petra (pi-durable). The request id makes a second submit of the same message do nothing.
export interface Conversation {
	submit(requestId: string, text: string): Promise<void>;
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
}

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
] as const;

// The text that Petra gives her conversation for one owner message. The model reads the command id and the
// channel from the first part, and gives them to the tool that it selects.
export function conversationText(commandId: string, channel: string, text: string): string {
	return `[command ${commandId} on ${channel}] ${text}`;
}

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

// The check jobs of the "jobs" queue. The night job comes in a later task.
async function runJob(work: TaskWork, command: Extract<Command, { type: "RunJob" }>): Promise<void> {
	if (!command.targetId) return;
	if (command.job === "check task") await work.checkTask(command.commandId, command.targetId);
	if (command.job === "check action") await work.checkAction(command.commandId, command.targetId);
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
		await out.tell({ sourceRef, channel, body: { type: "reply", text: answer.text } });
		return true;
	}

	async function handleTask(command: Command): Promise<void> {
		if (!work) return;
		if (command.type === "CancelTask") await work.cancel(command.taskId);
		else if (command.type === "SandboxExited") await work.sandboxExited(command);
		else if (command.type === "OwnerAnswer") await work.ownerAnswer(command);
		else if (command.type === "ResendSandboxRequests") await work.resendRequests();
		else if (command.type === "SetRule") await work.setRule(command);
		else if (command.type === "ApprovalDecision") await work.approvalDecision(command);
		else if (command.type === "RunJob") await runJob(work, command);
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
		} else {
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
		await storage.put(MARKER_KEY, true);
	}

	return {
		async accept(command, origin) {
			const status = await writer.receiveEvent({
				commandId: command.commandId,
				kind: command.type,
				payload: command,
				origin,
				at: command.at,
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
