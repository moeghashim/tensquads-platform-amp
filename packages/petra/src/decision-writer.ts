// The decision writer and its reader (docs/ARCHITECTURE.md, sections 4.7 and 7.2): the tables decisions and
// decision_outcomes. Only Petra uses it. Each method is one short transaction that names the account.
// The decisions package (packages/decisions) gets these methods as its store. This package does not import it (C2).
import type { Database, DecisionRecord, Transaction } from "@tensquads/core";

// What the owner did with a thing that a decision led to (requirement Q6).
export interface NewOutcome {
	// "exact": the record with this source reference. "prefix": each record whose source reference starts with it.
	match: "exact" | "prefix";
	ref: string;
	commandId: string;
	outcome: "approved" | "rejected" | "changed";
	by: string;
	at: string;
}

export interface DecisionWriter {
	// A row that is there does not change.
	addDecision(row: DecisionRecord): Promise<void>;
	// Writes one outcome for each record of a decider that matches. The records of the shadow mode and the choices
	// of the code get no outcome. A command that comes again changes nothing.
	addOutcome(outcome: NewOutcome): Promise<void>;
}

export interface DecisionReader {
	decisionRow(sourceRef: string, decider: string): Promise<DecisionRecord | undefined>;
	// The message of the customer that caused the task: the newest message in from the customer of the task,
	// at or before the start of the task. Undefined for a task with no customer (section 7.8).
	customerMessage(taskId: string): Promise<{ seq: number; text: string } | undefined>;
}

interface DecisionDbRow {
	source_ref: string;
	decider: string;
	task_id: string | null;
	point: string;
	message_seq: string | null;
	options: string[];
	answer: string | null;
	probability: number | null;
	shadow: boolean;
	used: boolean;
	ms: number | null;
	at: Date;
}

const toRecord = (row: DecisionDbRow): DecisionRecord => ({
	sourceRef: row.source_ref,
	decider: row.decider,
	taskId: row.task_id,
	point: row.point,
	messageSeq: row.message_seq === null ? null : Number(row.message_seq),
	options: row.options,
	answer: row.answer,
	probability: row.probability,
	shadow: row.shadow,
	used: row.used,
	ms: row.ms,
	at: row.at.toISOString(),
});

// The deciders that are not a decider port: the choices of the code and the answers of the owner.
const NOT_A_DECIDER = "('code', 'owner')";

export function decisionWriter(database: Database, accountId: string): DecisionWriter & DecisionReader {
	const run = <T>(work: (tx: Transaction) => Promise<T>) => database.transaction({ role: "petra", accountId }, work);
	return {
		addDecision: (row) =>
			run(async (tx) => {
				await tx.query(
					`INSERT INTO decisions (account_id, source_ref, decider, task_id, point, message_seq, options, answer,
					 probability, shadow, used, ms, at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT DO NOTHING`,
					[
						accountId,
						row.sourceRef,
						row.decider,
						row.taskId,
						row.point,
						row.messageSeq,
						JSON.stringify(row.options),
						row.answer,
						row.probability,
						row.shadow,
						row.used,
						row.ms,
						row.at,
					],
				);
			}),
		addOutcome: (outcome) =>
			run(async (tx) => {
				const match = outcome.match === "exact" ? "source_ref = $2" : "starts_with(source_ref, $2)";
				await tx.query(
					`INSERT INTO decision_outcomes (account_id, decision_ref, command_id, outcome, by, at)
					 SELECT DISTINCT $1::text, source_ref, $3::text, $4::text, $5::text, $6::timestamptz FROM decisions
					 WHERE ${match} AND NOT shadow AND decider NOT IN ${NOT_A_DECIDER}
					 ON CONFLICT DO NOTHING`,
					[accountId, outcome.ref, outcome.commandId, outcome.outcome, outcome.by, outcome.at],
				);
			}),
		decisionRow: (sourceRef, decider) =>
			run(async (tx) => {
				const rows = await tx.query<DecisionDbRow>(
					`SELECT source_ref, decider, task_id, point, message_seq, options, answer, probability, shadow, used, ms, at
					 FROM decisions WHERE source_ref = $1 AND decider = $2`,
					[sourceRef, decider],
				);
				return rows[0] ? toRecord(rows[0]) : undefined;
			}),
		customerMessage: (taskId) =>
			run(async (tx) => {
				const rows = await tx.query<{ seq: string; text: string | null }>(
					`SELECT m.seq, m.body ->> 'text' AS text FROM tasks t
					 JOIN messages m ON m.customer_ref = t.customer_ref AND m.direction = 'in' AND m.at <= t.created_at
					 WHERE t.id = $1 ORDER BY m.seq DESC LIMIT 1`,
					[taskId],
				);
				const row = rows[0];
				return row ? { seq: Number(row.seq), text: row.text ?? "" } : undefined;
			}),
	};
}
