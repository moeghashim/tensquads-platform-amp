// The messages of Petra to the owner (docs/ARCHITECTURE.md, sections 6.3 and 7.3).
// Each message is written one time, by its source reference, with the next seq of the account.
import type { OwnerMessage } from "@tensquads/contracts";

import type { AccountReader, AccountWriter, NewMessage } from "./account-writer.js";
import type { TrailWriter } from "./trail-writer.js";

// The storage of the Durable Object. The keys of Petra start with "petra_" (section 7.3).
export interface PetraStorage {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
}

const SEQ_KEY = "petra_seq";

// A message to the owner without its seq and its time. The outbox adds them.
export type OwnerMessageBody = OwnerMessage extends infer M
	? M extends OwnerMessage
		? Omit<M, "seq" | "at">
		: never
	: never;

export interface OutboxDeps {
	writer: AccountWriter & AccountReader;
	storage: PetraStorage;
	now: () => string;
	// Sends a message on the open streams. The outbox calls it only after the message is in the database.
	send: (message: OwnerMessage) => void;
	// Adds the trail row of a message about a task (requirement T6). Without it, the outbox adds no trail row.
	addTrail?: TrailWriter["addTrail"];
}

export interface Outbox {
	// Writes a message one time. Returns false when the row was there already.
	write(message: Omit<NewMessage, "seq">): Promise<boolean>;
	// Writes a message from Petra to the owner, then sends it on the open streams.
	tell(message: { sourceRef: string; channel: string; body: OwnerMessageBody; taskId?: string }): Promise<void>;
}

export function outbox(deps: OutboxDeps): Outbox {
	const { writer, storage } = deps;
	let writing: Promise<unknown> = Promise.resolve();

	// Petra saves the new value of the counter before she writes the message. A number is never used two times.
	// After a loss of the storage, the counter starts from the largest seq in messages (section 7.3).
	async function nextSeq(): Promise<number> {
		const seq = (await storage.get<number>(SEQ_KEY)) ?? (await writer.maxSeq());
		await storage.put(SEQ_KEY, seq + 1);
		return seq + 1;
	}

	// One write at a time, so two writes that run at the same time do not read the same counter.
	function write(message: Omit<NewMessage, "seq">): Promise<boolean> {
		const next = writing.then(async () => {
			if ((await writer.messageSeq(message.sourceRef)) !== undefined) return false;
			await writer.addMessage({ ...message, seq: await nextSeq() });
			return true;
		});
		writing = next.catch(() => undefined);
		return next;
	}

	return {
		write,
		async tell({ sourceRef, channel, body, taskId }) {
			const at = deps.now();
			const out = { direction: "out", sender: "petra", type: body.type, body, at } as const;
			const wrote = await write({ sourceRef, channel, ...out, ...(taskId ? { taskId } : {}) });
			// The trail row has its own key, so a second run adds it when the first run stopped before it.
			if (taskId && deps.addTrail) {
				await deps.addTrail({
					sourceRef: `${sourceRef}/trail`,
					taskId,
					attemptNo: null,
					turnNo: null,
					kind: "message to the owner",
					actor: "petra",
					summary: `Petra sent a message of the type ${body.type} to the owner.`,
					data: body,
					at,
				});
			}
			if (!wrote) return;
			const seq = await writer.messageSeq(sourceRef);
			if (seq === undefined) return;
			const [stored] = await writer.ownerMessagesAfter(seq - 1);
			if (stored) deps.send(stored);
		},
	};
}
