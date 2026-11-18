// The action writer and its reader (docs/ARCHITECTURE.md, sections 4.4 and 7.2): the tables actions, approvals,
// rules and draft_files. Only Petra uses it. Each method is one short transaction that names the account.
// Each write has a natural key, so a second call with the same key changes nothing.
// The gate (packages/gate) gets these methods as its store. This package does not import the gate (requirement C2).
import type { SignalDelivery } from "@tensquads/contracts";
import type { Database, Transaction } from "@tensquads/core";

export type ActionKindValue = "money" | "public" | "other";
export type ActionStatusValue = "pending" | "rejected" | "refused" | "started" | "done" | "not_confirmed";
export type ApprovalStatusValue = "pending" | "approved" | "rejected";

export interface StoredAction {
	taskId: string;
	toolCallId: string;
	attemptNo: number;
	tool: string;
	kind: ActionKindValue;
	content: Record<string, unknown>;
	contentHash: string;
	status: ActionStatusValue;
	answer: unknown;
	startedAt: string | null;
}

export interface StoredApproval {
	taskId: string;
	toolCallId: string;
	contentHash: string;
	status: ApprovalStatusValue;
	ruleId: string | null;
	limit: number | null;
	// The command id of the decision, or null while the approval is pending.
	decidedBy: string | null;
}

interface ActionDbRow {
	task_id: string;
	tool_call_id: string;
	attempt_no: number;
	tool: string;
	kind: ActionKindValue;
	content: Record<string, unknown>;
	content_hash: string;
	status: ActionStatusValue;
	answer: unknown;
	started_at: Date | null;
}

interface ApprovalDbRow {
	task_id: string;
	tool_call_id: string;
	content_hash: string;
	status: ApprovalStatusValue;
	rule_id: string | null;
	limit_at_that_time: number | null;
	decided_by: string | null;
}

const ACTION_COLUMNS =
	"task_id, tool_call_id, attempt_no, tool, kind, content, content_hash, status, answer, started_at";
const APPROVAL_COLUMNS = "task_id, tool_call_id, content_hash, status, rule_id, limit_at_that_time, decided_by";
// The id of an action and of its approval is "{taskId}/{toolCallId}".
const ID_OF_ROW = "task_id || '/' || tool_call_id";
const FINAL = "('done', 'not_confirmed', 'rejected', 'refused')";

function toAction(row: ActionDbRow): StoredAction {
	return {
		taskId: row.task_id,
		toolCallId: row.tool_call_id,
		attemptNo: row.attempt_no,
		tool: row.tool,
		kind: row.kind,
		content: row.content,
		contentHash: row.content_hash,
		status: row.status,
		answer: row.answer,
		startedAt: row.started_at ? row.started_at.toISOString() : null,
	};
}

function toApproval(row: ApprovalDbRow): StoredApproval {
	return {
		taskId: row.task_id,
		toolCallId: row.tool_call_id,
		contentHash: row.content_hash,
		status: row.status,
		ruleId: row.rule_id,
		limit: row.limit_at_that_time,
		decidedBy: row.decided_by,
	};
}

const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value));

async function oneAction(tx: Transaction, where: string, params: unknown[]): Promise<StoredAction | undefined> {
	const rows = await tx.query<ActionDbRow>(`SELECT ${ACTION_COLUMNS} FROM actions WHERE ${where}`, params);
	return rows[0] ? toAction(rows[0]) : undefined;
}

export interface DraftRow {
	path: string;
	blobKey: string;
}

export function actionWriter(database: Database, accountId: string) {
	const run = <T>(work: (tx: Transaction) => Promise<T>) => database.transaction({ role: "petra", accountId }, work);
	return {
		action: (taskId: string, toolCallId: string) =>
			run((tx) => oneAction(tx, "task_id = $1 AND tool_call_id = $2", [taskId, toolCallId])),
		actionById: (actionId: string) => run((tx) => oneAction(tx, `${ID_OF_ROW} = $1`, [actionId])),
		// Returns true when this call wrote the row.
		addAction: (row: Omit<StoredAction, "answer">) =>
			run(async (tx) => {
				const written = await tx.query(
					`INSERT INTO actions (account_id, ${ACTION_COLUMNS})
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10)
					 ON CONFLICT DO NOTHING RETURNING tool_call_id`,
					[
						accountId,
						row.taskId,
						row.toolCallId,
						row.attemptNo,
						row.tool,
						row.kind,
						JSON.stringify(row.content),
						row.contentHash,
						row.status,
						row.startedAt,
					],
				);
				return written.length > 0;
			}),
		// The status changes only if it is one of "from". The time of "started" and of a final status is kept.
		moveAction: (change: {
			taskId: string;
			toolCallId: string;
			from: readonly ActionStatusValue[];
			to: ActionStatusValue;
			answer?: unknown;
			at: string;
		}) =>
			run(async (tx) => {
				const moved = await tx.query(
					`UPDATE actions SET status = $4::text, answer = coalesce($5::jsonb, answer),
					 started_at = CASE WHEN $4::text = 'started' THEN $6::timestamptz ELSE started_at END,
					 done_at = CASE WHEN $4::text IN ${FINAL} THEN $6::timestamptz ELSE done_at END
					 WHERE task_id = $1 AND tool_call_id = $2
					 AND status IN (SELECT jsonb_array_elements_text($3::jsonb))
					 RETURNING tool_call_id`,
					[
						change.taskId,
						change.toolCallId,
						JSON.stringify(change.from),
						change.to,
						json(change.answer),
						change.at,
					],
				);
				return moved.length > 0;
			}),
		// The newest active rule of the kind wins.
		activeRule: (kind: string) =>
			run(async (tx) => {
				const rows = await tx.query<{ command_id: string; kind: string; params: Record<string, unknown> }>(
					`SELECT command_id, kind, params FROM rules WHERE kind = $1 AND active
					 ORDER BY created_at DESC, command_id DESC LIMIT 1`,
					[kind],
				);
				const row = rows[0];
				return row ? { ruleId: row.command_id, kind: row.kind, params: row.params } : undefined;
			}),
		// The key of a rule is the command id of its SetRule command.
		addRule: (rule: { commandId: string; kind: string; params: Record<string, unknown>; at: string }) =>
			run(async (tx) => {
				await tx.query(
					`INSERT INTO rules (account_id, command_id, kind, params, active, created_by, created_at)
					 VALUES ($1, $2, $3, $4, true, 'owner', $5) ON CONFLICT DO NOTHING`,
					[accountId, rule.commandId, rule.kind, JSON.stringify(rule.params), rule.at],
				);
			}),
		approval: (taskId: string, toolCallId: string, contentHash: string) =>
			run(async (tx) => {
				const rows = await tx.query<ApprovalDbRow>(
					`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE task_id = $1 AND tool_call_id = $2 AND content_hash = $3`,
					[taskId, toolCallId, contentHash],
				);
				return rows[0] ? toApproval(rows[0]) : undefined;
			}),
		addApproval: (row: Omit<StoredApproval, "status" | "decidedBy"> & { at: string }) =>
			run(async (tx) => {
				await tx.query(
					`INSERT INTO approvals (account_id, task_id, tool_call_id, content_hash, rule_id, limit_at_that_time, status)
					 VALUES ($1, $2, $3, $4, $5, $6, 'pending') ON CONFLICT DO NOTHING`,
					[accountId, row.taskId, row.toolCallId, row.contentHash, row.ruleId, json(row.limit ?? undefined)],
				);
			}),
		// Only a pending approval takes a decision. Returns true when this call decided it.
		decideApproval: (decision: {
			taskId: string;
			toolCallId: string;
			contentHash: string;
			status: "approved" | "rejected";
			decidedBy: string;
			at: string;
		}) =>
			run(async (tx) => {
				const decided = await tx.query(
					`UPDATE approvals SET status = $4, decided_by = $5, decided_at = $6
					 WHERE task_id = $1 AND tool_call_id = $2 AND content_hash = $3 AND status = 'pending'
					 RETURNING tool_call_id`,
					[
						decision.taskId,
						decision.toolCallId,
						decision.contentHash,
						decision.status,
						decision.decidedBy,
						decision.at,
					],
				);
				return decided.length > 0;
			}),
		// Each decided approval is a signal. The key is the tool-call id, because the loop parks on it (section 4.4).
		approvalSignals: (taskId: string) =>
			run(async (tx) => {
				const rows = await tx.query<{ tool_call_id: string; status: ApprovalStatusValue }>(
					`SELECT tool_call_id, status FROM approvals WHERE task_id = $1 AND status IN ('approved', 'rejected')
					 ORDER BY decided_at, tool_call_id`,
					[taskId],
				);
				return rows.map(
					(row): SignalDelivery => ({
						key: row.tool_call_id,
						value: { decision: row.status === "approved" ? "approve" : "reject" },
					}),
				);
			}),
		// The command ids of the decisions of the owner for one task.
		decisionCommands: (taskId: string) =>
			run(async (tx) => {
				const rows = await tx.query<{ decided_by: string }>(
					`SELECT decided_by FROM approvals WHERE task_id = $1 AND decided_by IS NOT NULL
					 ORDER BY decided_at, decided_by`,
					[taskId],
				);
				return rows.map((row) => row.decided_by);
			}),
		addDraftFile: (draft: {
			taskId: string;
			path: string;
			attemptNo: number;
			callNo: number;
			blobKey: string;
			at: string;
		}) =>
			run(async (tx) => {
				await tx.query(
					`INSERT INTO draft_files (account_id, task_id, path, attempt_no, call_no, blob_key, at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
					[accountId, draft.taskId, draft.path, draft.attemptNo, draft.callNo, draft.blobKey, draft.at],
				);
			}),
		// For each path, the newest file that is not newer than the copy. The columns are integers, so the
		// sort compares numbers, not text (section 4.3).
		draftFiles: (taskId: string, copy: { attemptNo: number; callNo: number }) =>
			run(async (tx) => {
				const rows = await tx.query<{ path: string; blob_key: string }>(
					`SELECT DISTINCT ON (path) path, blob_key FROM draft_files
					 WHERE task_id = $1 AND (attempt_no < $2 OR (attempt_no = $2 AND call_no <= $3))
					 ORDER BY path, attempt_no DESC, call_no DESC`,
					[taskId, copy.attemptNo, copy.callNo],
				);
				return rows.map((row): DraftRow => ({ path: row.path, blobKey: row.blob_key }));
			}),
	};
}

export type ActionWriter = ReturnType<typeof actionWriter>;
