// The logic of Petra for one account (docs/ARCHITECTURE.md, sections 4.6 and 7.3).
// The Durable Object class gives the storage, the model and the stream. This module has no Cloudflare import.
import type { Command, OwnerMessage } from "@tensquads/contracts";
import type { Model } from "@tensquads/core";

import type { AccountReader, AccountWriter, EventOrigin, NewMessage } from "./account-writer.js";

// The storage of the Durable Object. The keys of Petra start with "petra_" (section 7.3).
export interface PetraStorage {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
}

export interface PetraDeps {
	writer: AccountWriter & AccountReader;
	storage: PetraStorage;
	model: Model;
	now: () => string;
	// Sends a message on the open streams. Petra calls it only after the message is in the database.
	send: (message: OwnerMessage) => void;
}

const WORK_KEY = "petra_work";
const SEQ_KEY = "petra_seq";

// The command handlers of this task. Each later task adds its commands.
export const PETRA_HANDLES = ["OwnerMessage", "GrantCredits"] as const;

export interface Petra {
	// Writes the command to events, then puts it in the work list. Returns before the work is done (P4).
	accept(command: Command, origin: EventOrigin): Promise<void>;
	// Handles the work list one command at a time (P1).
	work(): Promise<void>;
	// After a start: makes the work list again from the events that are "received" (section 7.3).
	recover(): Promise<void>;
}

export function petra(deps: PetraDeps): Petra {
	const { writer, storage } = deps;
	let running: Promise<void> = Promise.resolve();

	async function workList(): Promise<Command[]> {
		return (await storage.get<Command[]>(WORK_KEY)) ?? [];
	}

	// Petra saves the new value of the counter before she writes the message. A number is never used two times.
	async function nextSeq(): Promise<number> {
		let seq = await storage.get<number>(SEQ_KEY);
		if (seq === undefined) {
			seq = await writer.maxSeq();
		}
		await storage.put(SEQ_KEY, seq + 1);
		return seq + 1;
	}

	// Writes a message one time. A command that runs again finds the row and uses no new seq.
	async function writeMessage(message: Omit<NewMessage, "seq">): Promise<number | undefined> {
		if ((await writer.messageSeq(message.sourceRef)) !== undefined) return undefined;
		return writer.addMessage({ ...message, seq: await nextSeq() });
	}

	async function handleOwnerMessage(command: Extract<Command, { type: "OwnerMessage" }>): Promise<void> {
		const { commandId, channel, text, at } = command;
		const inbound = { direction: "in", channel, sender: "owner", type: "owner_message", body: { text }, at } as const;
		await writeMessage({ sourceRef: `cmd/${commandId}/in`, ...inbound });
		const sourceRef = `cmd/${commandId}/reply`;
		// A command that runs again keeps its first reply. Petra does not ask the model again.
		if ((await writer.messageSeq(sourceRef)) !== undefined) return;
		const answer = await deps.model.complete({ messages: [{ role: "user", content: text }], tools: [] });
		const body = { type: "reply", text: answer.text };
		const out = { direction: "out", channel, sender: "petra", type: "reply", body, at: deps.now() } as const;
		const seq = await writeMessage({ sourceRef, ...out });
		if (seq === undefined) return;
		const [stored] = await writer.ownerMessagesAfter(seq - 1);
		if (stored) deps.send(stored);
	}

	async function handle(command: Command): Promise<void> {
		if (command.type === "OwnerMessage") {
			await handleOwnerMessage(command);
		} else if (command.type === "GrantCredits") {
			await writer.addGrant({
				sourceRef: `cmd/${command.commandId}/grant`,
				credits: command.credits,
				at: command.at,
			});
		}
		await writer.finishEvent(command.commandId);
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
		async recover() {
			for (const event of await writer.receivedEvents()) {
				await enqueue(event.payload as Command);
			}
		},
	};
}
