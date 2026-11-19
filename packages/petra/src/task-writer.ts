// The task writer and its reader (docs/ARCHITECTURE.md, sections 3.5, 4.3 and 4.6).
// Only Petra uses it. Each method is one short transaction that names the account.
// Each write has a key from its cause, so a second call with the same key changes nothing.

import type { AttemptVersions, Brief, InboxMessage, SignalDelivery, StopName } from "@tensquads/contracts";
import type { Database, Transaction } from "@tensquads/core";

import { type TrailReader, type TrailWriter, trailWriter } from "./trail-writer.js";

export type TaskStatus = "starting" | "running" | "waiting for the owner" | "done" | "failed" | "cancelled";

export type AttemptReason =
	| "first"
	| "after an approval"
	| "after an answer"
	| "after a failure"
	| "the sandbox did not start";

export interface TaskRow {
	id: string;
	commandId: string;
	bot: string;
	taskType: string;
	brief: Brief;
	status: TaskStatus;
	stop: StopName | null;
}

export interface AttemptRow {
	taskId: string;
	attemptNo: number;
	causeRef: string;
	runnerId: string | null;
	reason: AttemptReason;
	versions: Partial<AttemptVersions>;
	exit: string | null;
	// The time of the first `start` call, or null when no runner started.
	startedAt: string | null;
}

// A decision row (section 4.6). Each one has a key from its cause, so a second run reads the first answer.
export interface NewDecision {
	sourceRef: string;
	decider: string;
	taskId: string | null;
	point: string;
	options: readonly string[];
	answer: string;
	at: string;
}

export interface JournalCopyRow {
	attemptNo: number;
	callNo: number;
	blobKey: string;
}

export type NewInboxRow = { taskId: string; sourceRef: string; at: string } & (
	| { kind: "message"; text: string }
	| { kind: "forget"; factId: string }
);

export interface TaskWriter extends TrailWriter {
	// Step 1 of "start a task". The id of the task is the command id. Returns the task id.
	createTask(task: { commandId: string; bot: string; taskType: string; brief: Brief; at: string }): Promise<string>;
	// Step 2. The ledger row has the key "task/{taskId}/charge".
	chargeTask(charge: { taskId: string; credits: number; at: string }): Promise<void>;
	// Adds the attempt with the next number. A cause that comes again gets the number of its first attempt.
	addAttempt(attempt: {
		taskId: string;
		causeRef: string;
		reason: AttemptReason;
		versions: Partial<AttemptVersions>;
	}): Promise<number>;
	// The first runner id wins. Returns the runner id of the attempt after the write.
	bindRunner(bind: { taskId: string; attemptNo: number; runnerId: string; at: string }): Promise<string>;
	// Adds the values to the versions of the attempt (requirement L11).
	recordVersions(taskId: string, attemptNo: number, versions: Partial<AttemptVersions>): Promise<void>;
	// The first exit of an attempt stays.
	endAttempt(end: { taskId: string; attemptNo: number; exit: string; at: string }): Promise<void>;
	addJournalCopy(copy: {
		taskId: string;
		attemptNo: number;
		callNo: number;
		blobKey: string;
		at: string;
	}): Promise<void>;
	addInbox(row: NewInboxRow): Promise<void>;
	// A task that ended does not change again.
	setTaskStatus(change: { taskId: string; status: TaskStatus; stop?: StopName; at: string }): Promise<void>;
	// The ledger row has the key "task/{taskId}/giveback".
	giveBack(refund: { taskId: string; credits: number; at: string }): Promise<void>;
	addDecision(decision: NewDecision): Promise<void>;
}

export interface TaskReader extends TrailReader {
	task(taskId: string): Promise<TaskRow | undefined>;
	// The attempt with the largest number.
	currentAttempt(taskId: string): Promise<AttemptRow | undefined>;
	// The copy with the largest attempt number, then the largest call number.
	newestJournalCopy(taskId: string): Promise<JournalCopyRow | undefined>;
	// All the messages of the task and the full forget list.
	inbox(taskId: string): Promise<{ messages: InboxMessage[]; forget: string[] }>;
	// All the attempts of the task, by number.
	attempts(taskId: string): Promise<AttemptRow[]>;
	// The tasks that did not end, the oldest first.
	openTasks(): Promise<TaskRow[]>;
	// The answer of a decision row, or undefined.
	decision(sourceRef: string, decider: string): Promise<string | undefined>;
	// The answers of the owner to the questions of the task. The runner delivers each one as a signal (L6).
	signals(taskId: string): Promise<SignalDelivery[]>;
	// The task of a question that Petra sent to the owner, or undefined.
	questionTask(questionId: string): Promise<string | undefined>;
}

const ENDED = "('done', 'failed', 'cancelled')";

interface AttemptDbRow {
	task_id: string;
	attempt_no: number;
	cause_ref: string;
	runner_id: string | null;
	reason: AttemptReason;
	versions: Partial<AttemptVersions>;
	exit: string | null;
	started_at: Date | null;
}

const ATTEMPT_COLUMNS = "task_id, attempt_no, cause_ref, runner_id, reason, versions, exit, started_at";

function toAttemptRow(row: AttemptDbRow): AttemptRow {
	return {
		taskId: row.task_id,
		attemptNo: row.attempt_no,
		causeRef: row.cause_ref,
		runnerId: row.runner_id,
		reason: row.reason,
		versions: row.versions,
		exit: row.exit,
		startedAt: row.started_at ? row.started_at.toISOString() : null,
	};
}

interface TaskDbRow {
	id: string;
	command_id: string;
	bot: string;
	task_type: string;
	brief: Brief;
	status: TaskStatus;
	stop: StopName | null;
}

const TASK_COLUMNS = "id, command_id, bot, task_type, brief, status, stop";

function toTaskRow(row: TaskDbRow): TaskRow {
	const { command_id: commandId, task_type: taskType, ...rest } = row;
	return { ...rest, commandId, taskType };
}

// The prefix of the key of an answer of the owner. The rest of the key is the id of the question.
const ANSWER_PREFIX = "answer/";

// The key of the decision row of an answer of the owner.
export const answerRef = (questionId: string): string => `${ANSWER_PREFIX}${questionId}`;

export function taskWriter(database: Database, accountId: string): TaskWriter & TaskReader {
	const run = <T>(work: (tx: Transaction) => Promise<T>) => database.transaction({ role: "petra", accountId }, work);
	const addLedger = (sourceRef: string, taskId: string, kind: "charge" | "give back", credits: number, at: string) =>
		run(async (tx) => {
			await tx.query(
				`INSERT INTO ledger (account_id, source_ref, task_id, kind, credits, at)
				 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
				[accountId, sourceRef, taskId, kind, credits, at],
			);
		});
	return {
		...trailWriter(database, accountId),
		createTask: (task) =>
			run(async (tx) => {
				await tx.query(
					`INSERT INTO tasks (id, account_id, command_id, bot, task_type, brief, status, created_at)
					 VALUES ($1, $2, $1, $3, $4, $5, 'starting', $6) ON CONFLICT DO NOTHING`,
					[task.commandId, accountId, task.bot, task.taskType, JSON.stringify(task.brief), task.at],
				);
				return task.commandId;
			}),
		// A charge takes credits, so the row has a negative value. The balance is the sum of the ledger.
		chargeTask: (charge) =>
			addLedger(`task/${charge.taskId}/charge`, charge.taskId, "charge", -charge.credits, charge.at),
		giveBack: (refund) =>
			addLedger(`task/${refund.taskId}/giveback`, refund.taskId, "give back", refund.credits, refund.at),
		addAttempt: (attempt) =>
			run(async (tx) => {
				await tx.query(
					`INSERT INTO attempts (task_id, attempt_no, account_id, cause_ref, reason, versions)
					 SELECT $1::text, coalesce(max(attempt_no), 0) + 1, $2::text, $3::text, $4::text, $5::jsonb
					 FROM attempts WHERE task_id = $1::text
					 ON CONFLICT DO NOTHING`,
					[attempt.taskId, accountId, attempt.causeRef, attempt.reason, JSON.stringify(attempt.versions)],
				);
				const rows = await tx.query<{ attempt_no: number }>(
					"SELECT attempt_no FROM attempts WHERE task_id = $1 AND cause_ref = $2",
					[attempt.taskId, attempt.causeRef],
				);
				if (!rows[0]) throw new Error(`The attempt of the cause "${attempt.causeRef}" was not written.`);
				return rows[0].attempt_no;
			}),
		bindRunner: (bind) =>
			run(async (tx) => {
				await tx.query(
					`UPDATE attempts SET runner_id = $3, started_at = $4
					 WHERE task_id = $1 AND attempt_no = $2 AND runner_id IS NULL`,
					[bind.taskId, bind.attemptNo, bind.runnerId, bind.at],
				);
				const rows = await tx.query<{ runner_id: string }>(
					"SELECT runner_id FROM attempts WHERE task_id = $1 AND attempt_no = $2",
					[bind.taskId, bind.attemptNo],
				);
				if (!rows[0]) throw new Error(`The task "${bind.taskId}" has no attempt ${bind.attemptNo}.`);
				return rows[0].runner_id;
			}),
		recordVersions: (taskId, attemptNo, versions) =>
			run(async (tx) => {
				await tx.query(
					"UPDATE attempts SET versions = versions || $3::jsonb WHERE task_id = $1 AND attempt_no = $2",
					[taskId, attemptNo, JSON.stringify(versions)],
				);
			}),
		endAttempt: (end) =>
			run(async (tx) => {
				await tx.query(
					`UPDATE attempts SET exit = $3, ended_at = $4
					 WHERE task_id = $1 AND attempt_no = $2 AND exit IS NULL`,
					[end.taskId, end.attemptNo, end.exit, end.at],
				);
			}),
		addJournalCopy: (copy) =>
			run(async (tx) => {
				await tx.query(
					`INSERT INTO journal_copies (task_id, attempt_no, call_no, account_id, blob_key, at)
					 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
					[copy.taskId, copy.attemptNo, copy.callNo, accountId, copy.blobKey, copy.at],
				);
			}),
		addInbox: (row) =>
			run(async (tx) => {
				const body = row.kind === "message" ? JSON.stringify({ text: row.text }) : null;
				const factId = row.kind === "forget" ? row.factId : null;
				await tx.query(
					`INSERT INTO task_inbox (task_id, source_ref, account_id, kind, body, fact_id, at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
					[row.taskId, row.sourceRef, accountId, row.kind, body, factId, row.at],
				);
			}),
		addDecision: (decision) =>
			run(async (tx) => {
				await tx.query(
					`INSERT INTO decisions (account_id, source_ref, decider, task_id, point, options, answer, shadow, used, at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, false, true, $8) ON CONFLICT DO NOTHING`,
					[
						accountId,
						decision.sourceRef,
						decision.decider,
						decision.taskId,
						decision.point,
						JSON.stringify(decision.options),
						decision.answer,
						decision.at,
					],
				);
			}),
		setTaskStatus: (change) =>
			run(async (tx) => {
				await tx.query(
					`UPDATE tasks SET status = $2::text, stop = coalesce($3::text, stop),
					 ended_at = CASE WHEN $2::text IN ${ENDED} THEN $4::timestamptz ELSE ended_at END
					 WHERE id = $1 AND status NOT IN ${ENDED}`,
					[change.taskId, change.status, change.stop ?? null, change.at],
				);
			}),
		task: (taskId) =>
			run(async (tx) => {
				const rows = await tx.query<TaskDbRow>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1`, [taskId]);
				return rows[0] ? toTaskRow(rows[0]) : undefined;
			}),
		openTasks: () =>
			run(async (tx) => {
				const rows = await tx.query<TaskDbRow>(
					`SELECT ${TASK_COLUMNS} FROM tasks WHERE status NOT IN ${ENDED} ORDER BY created_at, id`,
				);
				return rows.map(toTaskRow);
			}),
		currentAttempt: (taskId) =>
			run(async (tx) => {
				const rows = await tx.query<AttemptDbRow>(
					`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE task_id = $1 ORDER BY attempt_no DESC LIMIT 1`,
					[taskId],
				);
				return rows[0] ? toAttemptRow(rows[0]) : undefined;
			}),
		attempts: (taskId) =>
			run(async (tx) => {
				const rows = await tx.query<AttemptDbRow>(
					`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE task_id = $1 ORDER BY attempt_no`,
					[taskId],
				);
				return rows.map(toAttemptRow);
			}),
		decision: (sourceRef, decider) =>
			run(async (tx) => {
				const rows = await tx.query<{ answer: string | null }>(
					"SELECT answer FROM decisions WHERE source_ref = $1 AND decider = $2",
					[sourceRef, decider],
				);
				return rows[0]?.answer ?? undefined;
			}),
		signals: (taskId) =>
			run(async (tx) => {
				const rows = await tx.query<{ source_ref: string; answer: string }>(
					`SELECT source_ref, answer FROM decisions
					 WHERE task_id = $1 AND decider = 'owner' AND point = 'question' ORDER BY at, source_ref`,
					[taskId],
				);
				return rows.map((row) => ({
					key: row.source_ref.slice(ANSWER_PREFIX.length),
					value: { text: row.answer },
				}));
			}),
		questionTask: (questionId) =>
			run(async (tx) => {
				const rows = await tx.query<{ task_id: string | null }>(
					"SELECT task_id FROM messages WHERE type = 'question' AND body ->> 'questionId' = $1",
					[questionId],
				);
				return rows[0]?.task_id ?? undefined;
			}),
		// The columns are integers, so the sort compares numbers, not text.
		newestJournalCopy: (taskId) =>
			run(async (tx) => {
				const rows = await tx.query<{ attempt_no: number; call_no: number; blob_key: string }>(
					`SELECT attempt_no, call_no, blob_key FROM journal_copies WHERE task_id = $1
					 ORDER BY attempt_no DESC, call_no DESC LIMIT 1`,
					[taskId],
				);
				const row = rows[0];
				return row ? { attemptNo: row.attempt_no, callNo: row.call_no, blobKey: row.blob_key } : undefined;
			}),
		inbox: (taskId) =>
			run(async (tx) => {
				const rows = await tx.query<{
					source_ref: string;
					kind: "message" | "forget";
					body: { text: string } | null;
					fact_id: string | null;
				}>("SELECT source_ref, kind, body, fact_id FROM task_inbox WHERE task_id = $1 ORDER BY at, source_ref", [
					taskId,
				]);
				const messages: InboxMessage[] = [];
				const forget: string[] = [];
				for (const row of rows) {
					if (row.kind === "message" && row.body)
						messages.push({ sourceRef: row.source_ref, text: row.body.text });
					if (row.kind === "forget" && row.fact_id) forget.push(row.fact_id);
				}
				return { messages, forget };
			}),
	};
}
