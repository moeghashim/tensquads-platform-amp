// The account writer and its reader (docs/ARCHITECTURE.md, section 3.3).
// Only Petra uses it. Each method is one short transaction that names the account.
// Each write has a natural key, so a second call with the same key changes nothing (requirement P6).

import type { OwnerMessage } from "@tensquads/contracts";
import type { Database, Transaction } from "@tensquads/core";

export type EventOrigin = "owner" | "bot" | "not trusted" | "system";

export interface EventRow {
	commandId: string;
	kind: string;
	payload: unknown;
	status: "received" | "done";
}

export interface NewMessage {
	sourceRef: string;
	seq: number;
	direction: "in" | "out";
	channel: string;
	sender: string;
	type: string;
	body: unknown;
	at: string;
	// The task of the message, if it has one.
	taskId?: string;
}

// A message of the owner to Petra, as the account reader gives it.
export interface OwnerInput {
	sourceRef: string;
	channel: string;
	text: string;
}

export interface AccountWriter {
	// The first write of a command. Returns the status of the row, which can be "done" from an earlier run.
	receiveEvent(event: {
		commandId: string;
		kind: string;
		payload: unknown;
		origin: EventOrigin;
		at: string;
	}): Promise<"received" | "done">;
	finishEvent(commandId: string): Promise<void>;
	// Returns the seq of the row. A write that comes again keeps the first seq.
	addMessage(message: NewMessage): Promise<number>;
	addGrant(grant: { sourceRef: string; credits: number; at: string }): Promise<void>;
}

export interface AccountReader {
	receivedEvents(): Promise<EventRow[]>;
	maxSeq(): Promise<number>;
	// The seq of the message with this source reference, or undefined.
	messageSeq(sourceRef: string): Promise<number | undefined>;
	ownerMessagesAfter(seq: number): Promise<OwnerMessage[]>;
	// The last messages of the owner to Petra, the oldest first.
	lastOwnerInputs(limit: number): Promise<OwnerInput[]>;
	isOwner(identityRef: string): Promise<boolean>;
	balance(): Promise<number>;
	// The status of one task of the account, or undefined.
	taskStatus(taskId: string): Promise<string | undefined>;
}

export function accountWriter(database: Database, accountId: string): AccountWriter & AccountReader {
	const run = <T>(work: (tx: Transaction) => Promise<T>) => database.transaction({ role: "petra", accountId }, work);
	return {
		receiveEvent: (event) =>
			run(async (tx) => {
				await tx.query(
					`INSERT INTO events (account_id, command_id, kind, payload, origin, status, received_at)
					 VALUES ($1, $2, $3, $4, $5, 'received', $6) ON CONFLICT DO NOTHING`,
					[accountId, event.commandId, event.kind, JSON.stringify(event.payload), event.origin, event.at],
				);
				const rows = await tx.query<{ status: "received" | "done" }>(
					"SELECT status FROM events WHERE account_id = $1 AND command_id = $2",
					[accountId, event.commandId],
				);
				return rows[0]!.status;
			}),
		finishEvent: (commandId) =>
			run(async (tx) => {
				await tx.query("UPDATE events SET status = 'done' WHERE account_id = $1 AND command_id = $2", [
					accountId,
					commandId,
				]);
			}),
		addMessage: (message) =>
			run(async (tx) => {
				await tx.query(
					`INSERT INTO messages (account_id, source_ref, seq, direction, channel, sender, type, body, at, task_id)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (account_id, source_ref) DO NOTHING`,
					[
						accountId,
						message.sourceRef,
						message.seq,
						message.direction,
						message.channel,
						message.sender,
						message.type,
						JSON.stringify(message.body),
						message.at,
						message.taskId ?? null,
					],
				);
				const rows = await tx.query<{ seq: string }>(
					"SELECT seq FROM messages WHERE account_id = $1 AND source_ref = $2",
					[accountId, message.sourceRef],
				);
				return Number(rows[0]!.seq);
			}),
		addGrant: (grant) =>
			run(async (tx) => {
				await tx.query(
					`INSERT INTO ledger (account_id, source_ref, kind, credits, at)
					 VALUES ($1, $2, 'grant', $3, $4) ON CONFLICT DO NOTHING`,
					[accountId, grant.sourceRef, grant.credits, grant.at],
				);
			}),
		receivedEvents: () =>
			run(async (tx) => {
				const rows = await tx.query<{ command_id: string; kind: string; payload: unknown; status: "received" }>(
					"SELECT command_id, kind, payload, status FROM events WHERE status = 'received' ORDER BY received_at, command_id",
				);
				return rows.map((row) => ({
					commandId: row.command_id,
					kind: row.kind,
					payload: row.payload,
					status: row.status,
				}));
			}),
		maxSeq: () =>
			run(async (tx) => {
				const rows = await tx.query<{ seq: string | null }>("SELECT max(seq) AS seq FROM messages");
				return Number(rows[0]?.seq ?? 0);
			}),
		messageSeq: (sourceRef) =>
			run(async (tx) => {
				const rows = await tx.query<{ seq: string }>("SELECT seq FROM messages WHERE source_ref = $1", [sourceRef]);
				return rows[0] ? Number(rows[0].seq) : undefined;
			}),
		ownerMessagesAfter: (seq) =>
			run(async (tx) => {
				const rows = await tx.query<{ seq: string; body: Record<string, unknown>; at: Date }>(
					"SELECT seq, body, at FROM messages WHERE direction = 'out' AND seq > $1 ORDER BY seq",
					[seq],
				);
				return rows.map((row) => ({ ...row.body, seq: Number(row.seq), at: row.at.toISOString() }) as OwnerMessage);
			}),
		lastOwnerInputs: (limit) =>
			run(async (tx) => {
				const rows = await tx.query<{ source_ref: string; channel: string; body: { text: string } }>(
					`SELECT source_ref, channel, body FROM messages
					 WHERE direction = 'in' AND sender = 'owner' ORDER BY seq DESC LIMIT $1`,
					[limit],
				);
				return rows
					.reverse()
					.map((row) => ({ sourceRef: row.source_ref, channel: row.channel, text: row.body.text }));
			}),
		isOwner: (identityRef) =>
			run(async (tx) => {
				const rows = await tx.query("SELECT 1 FROM owners WHERE account_id = $1 AND identity_ref = $2", [
					accountId,
					identityRef,
				]);
				return rows.length > 0;
			}),
		taskStatus: (taskId) =>
			run(async (tx) => {
				const rows = await tx.query<{ status: string }>("SELECT status FROM tasks WHERE id = $1", [taskId]);
				return rows[0]?.status;
			}),
		balance: () =>
			run(async (tx) => {
				const rows = await tx.query<{ credits: string | null }>("SELECT sum(credits) AS credits FROM ledger");
				return Number(rows[0]?.credits ?? 0);
			}),
	};
}
