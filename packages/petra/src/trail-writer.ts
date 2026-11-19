// The trail writer and its reader (docs/ARCHITECTURE.md, sections 7.2, 7.4 and 7.7).
// Only Petra uses it. Each method is one short transaction that names the account.
// The trail package (packages/trail) holds the rules. This module only has the SQL.

import type { Database, Transaction } from "@tensquads/core";

import type { AttemptReason } from "./task-writer.js";

export type TrailKind =
	| "owner message"
	| "decision"
	| "model call"
	| "tool use"
	| "check"
	| "approval"
	| "action"
	| "refusal"
	| "message to the owner"
	| "memory";

export interface NewTrailRow {
	sourceRef: string;
	// A row with no task has null here.
	taskId: string | null;
	attemptNo: number | null;
	turnNo: number | null;
	kind: TrailKind;
	actor: string;
	summary: string;
	data?: unknown;
	// A large item is in the object store. The row keeps its key and its SHA-256 hash (requirement T7).
	blobKey?: string | null;
	blobHash?: string | null;
	at: string;
}

export interface TrailRow extends NewTrailRow {
	data: unknown;
	blobKey: string | null;
	blobHash: string | null;
}

// A row of the full trail of a task (requirement T6), with the reason of its attempt.
export interface TaskTrailRow extends TrailRow {
	seq: number;
	attemptReason: AttemptReason | null;
}

// A row that the night job can delete, with the key of its item in the object store.
export interface ExpiredTrailRow {
	sourceRef: string;
	blobKey: string | null;
}

// What a task does now (requirement L7). Each value comes from the trail rows of the task.
export interface TaskActivity {
	taskId: string;
	bot: string;
	attemptNo: number;
	turnNo: number | null;
	toolCall: { id: string; tool: string } | null;
	firstAt: string;
	lastAt: string;
	// The time from the first row of the task to now, and from the last row to now.
	sinceFirstMs: number;
	sinceLastMs: number;
}

export interface TrailWriter {
	// A row that is there does not change.
	addTrail(row: NewTrailRow): Promise<void>;
	// Deletes the rows with these keys. The database deletes only the rows that its retention rule allows.
	deleteTrail(sourceRefs: readonly string[]): Promise<number>;
}

export interface TrailReader {
	trailRow(sourceRef: string): Promise<TrailRow | undefined>;
	// The number of trail rows of one kind for the task, in all attempts.
	countTrail(taskId: string, kind: TrailKind): Promise<number>;
	taskActivity(taskId: string, now: string): Promise<TaskActivity | undefined>;
	// All the rows of one task, in the sequence of seq, with the reason of each attempt.
	taskTrail(taskId: string): Promise<TaskTrailRow[]>;
	// The rows that are due for deletion, by the time of the database (requirement T8).
	expiredTrail(): Promise<ExpiredTrailRow[]>;
}

interface TrailDbRow {
	source_ref: string;
	task_id: string | null;
	attempt_no: number | null;
	turn_no: number | null;
	kind: TrailKind;
	actor: string;
	summary: string;
	data: unknown;
	blob_key: string | null;
	blob_hash: string | null;
	at: Date;
}

const TRAIL_COLUMNS = "source_ref, task_id, attempt_no, turn_no, kind, actor, summary, data, blob_key, blob_hash, at";

function toTrailRow(row: TrailDbRow): TrailRow {
	return {
		sourceRef: row.source_ref,
		taskId: row.task_id,
		attemptNo: row.attempt_no,
		turnNo: row.turn_no,
		kind: row.kind,
		actor: row.actor,
		summary: row.summary,
		data: row.data,
		blobKey: row.blob_key,
		blobHash: row.blob_hash,
		at: row.at.toISOString(),
	};
}

function toolCallOf(data: unknown): { id: string; tool: string } | null {
	const value = data as { toolCallId?: unknown; tool?: unknown } | null;
	if (typeof value?.toolCallId !== "string" || typeof value.tool !== "string") return null;
	return { id: value.toolCallId, tool: value.tool };
}

// The rows of the bot in its attempts. The rows of the owner and of Petra have no attempt.
async function activity(tx: Transaction, taskId: string, now: string): Promise<TaskActivity | undefined> {
	const [last] = await tx.query<TrailDbRow & { attempt_no: number }>(
		`SELECT ${TRAIL_COLUMNS} FROM trail WHERE task_id = $1 AND attempt_no IS NOT NULL ORDER BY seq DESC LIMIT 1`,
		[taskId],
	);
	if (!last) return undefined;
	const [tool] = await tx.query<TrailDbRow>(
		`SELECT ${TRAIL_COLUMNS} FROM trail WHERE task_id = $1 AND kind = 'tool use' ORDER BY seq DESC LIMIT 1`,
		[taskId],
	);
	const [first] = await tx.query<{ at: Date }>(
		"SELECT min(at) AS at FROM trail WHERE task_id = $1 AND attempt_no IS NOT NULL",
		[taskId],
	);
	const nowMs = Date.parse(now);
	const firstAt = first?.at ?? last.at;
	return {
		taskId,
		bot: last.actor,
		attemptNo: last.attempt_no,
		turnNo: last.turn_no,
		toolCall: tool ? toolCallOf(tool.data) : null,
		firstAt: firstAt.toISOString(),
		lastAt: last.at.toISOString(),
		sinceFirstMs: nowMs - firstAt.getTime(),
		sinceLastMs: nowMs - last.at.getTime(),
	};
}

// The same rule as the policy of migration 0005. The policy decides. This query only finds the rows.
const EXPIRED = `(trail.task_id IS NULL AND trail.at < now() - interval '1 month')
	OR EXISTS (SELECT 1 FROM tasks WHERE tasks.id = trail.task_id
		AND tasks.status IN ('done', 'failed', 'cancelled') AND tasks.ended_at < now() - interval '1 month')`;

export function trailWriter(database: Database, accountId: string): TrailWriter & TrailReader {
	const run = <T>(work: (tx: Transaction) => Promise<T>) => database.transaction({ role: "petra", accountId }, work);
	return {
		addTrail: (row) =>
			run(async (tx) => {
				await tx.query(
					`INSERT INTO trail (account_id, ${TRAIL_COLUMNS})
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING`,
					[
						accountId,
						row.sourceRef,
						row.taskId,
						row.attemptNo,
						row.turnNo,
						row.kind,
						row.actor,
						row.summary,
						row.data === undefined ? null : JSON.stringify(row.data),
						row.blobKey ?? null,
						row.blobHash ?? null,
						row.at,
					],
				);
			}),
		deleteTrail: (sourceRefs) =>
			run(async (tx) => {
				const rows = await tx.query<{ source_ref: string }>(
					"DELETE FROM trail WHERE source_ref = ANY($1::text[]) RETURNING source_ref",
					[sourceRefs],
				);
				return rows.length;
			}),
		trailRow: (sourceRef) =>
			run(async (tx) => {
				const rows = await tx.query<TrailDbRow>(`SELECT ${TRAIL_COLUMNS} FROM trail WHERE source_ref = $1`, [
					sourceRef,
				]);
				return rows[0] ? toTrailRow(rows[0]) : undefined;
			}),
		countTrail: (taskId, kind) =>
			run(async (tx) => {
				const rows = await tx.query<{ n: string }>(
					"SELECT count(*) AS n FROM trail WHERE task_id = $1 AND kind = $2",
					[taskId, kind],
				);
				return Number(rows[0]?.n ?? 0);
			}),
		taskActivity: (taskId, now) => run((tx) => activity(tx, taskId, now)),
		taskTrail: (taskId) =>
			run(async (tx) => {
				const rows = await tx.query<TrailDbRow & { seq: string; reason: AttemptReason | null }>(
					`SELECT ${TRAIL_COLUMNS.split(", ")
						.map((column) => `trail.${column}`)
						.join(", ")}, trail.seq, attempts.reason
					 FROM trail LEFT JOIN attempts
					 ON attempts.task_id = trail.task_id AND attempts.attempt_no = trail.attempt_no
					 WHERE trail.task_id = $1 ORDER BY trail.seq`,
					[taskId],
				);
				return rows.map((row) => ({ ...toTrailRow(row), seq: Number(row.seq), attemptReason: row.reason }));
			}),
		expiredTrail: () =>
			run(async (tx) => {
				const rows = await tx.query<{ source_ref: string; blob_key: string | null }>(
					`SELECT source_ref, blob_key FROM trail WHERE ${EXPIRED} ORDER BY seq`,
				);
				return rows.map((row) => ({ sourceRef: row.source_ref, blobKey: row.blob_key }));
			}),
	};
}
