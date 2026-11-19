// Reads the record of one run of a case: the rows of its test account, the sends in the log of the Worker, and the
// model requests that the proxy saw. The code grader checks this record (requirement E1).
import type { RunRecord } from "@tensquads/evals";

import { claimsOf, type LocalPath } from "./full-path.js";

export interface RecordInput {
	accountId: string;
	// The seq of the last message of the setup. The record has only the messages after it.
	setupSeq: number;
	facts: readonly { id: string; text: string }[];
	// The number of gateway calls when the hold of the step ended.
	releasedAt: number;
}

interface ActionDbRow {
	tool: string;
	status: string;
	amount: number | null;
	started_at: Date | null;
	approval_status: string | null;
	decided_at: Date | null;
}

const iso = (date: Date | null) => (date ? date.toISOString() : null);

// Each line "channel-test: would send {id} {json}" or "payment-test: would send ..." of a task of the account.
function sendsOf(workerLog: string, accountId: string): RunRecord["sends"] {
	const pattern = /(channel|payment)-test: would send (\S+)/g;
	return [...workerLog.matchAll(pattern)]
		.filter((match) => match[2]?.startsWith(`${accountId}-`))
		.map((match) => ({ port: match[1] as "channel" | "payment", id: match[2] ?? "" }));
}

function modelRequestsOf(path: LocalPath, input: RecordInput): RunRecord["modelRequests"] {
	return path.calls.flatMap((call, index) =>
		call.call === "model" && claimsOf(call.pass).accountId === input.accountId
			? [{ afterForget: index >= input.releasedAt, text: (call.messages ?? []).map((m) => m.content).join("\n") }]
			: [],
	);
}

async function actionsOf(path: LocalPath, accountId: string): Promise<RunRecord["actions"]> {
	const rows = await path.query<ActionDbRow>(
		`SELECT a.tool, a.status, (a.content->>'amount')::float8 AS amount, a.started_at,
		 ap.status AS approval_status, ap.decided_at
		 FROM actions a LEFT JOIN approvals ap ON ap.task_id = a.task_id AND ap.tool_call_id = a.tool_call_id
		 AND ap.content_hash = a.content_hash WHERE a.account_id = $1 ORDER BY a.task_id, a.tool_call_id`,
		[accountId],
	);
	return rows.map((row) => ({
		tool: row.tool,
		status: row.status,
		amount: row.amount,
		startedAt: iso(row.started_at),
		approval: row.approval_status ? { status: row.approval_status, decidedAt: iso(row.decided_at) } : null,
	}));
}

export async function readRecord(path: LocalPath, input: RecordInput): Promise<RunRecord> {
	const { accountId } = input;
	const tasks = await path.query<{ id: string; status: string }>(
		"SELECT id, status FROM tasks WHERE account_id = $1 ORDER BY id",
		[accountId],
	);
	const messages = await path.query<{ type: string; body: Record<string, unknown> }>(
		"SELECT type, body FROM messages WHERE account_id = $1 AND direction = 'out' AND seq > $2 ORDER BY seq",
		[accountId, input.setupSeq],
	);
	const [credits] = await path.query<{ n: string }>(
		"SELECT coalesce(-sum(credits), 0) AS n FROM ledger WHERE account_id = $1 AND kind IN ('charge', 'give back')",
		[accountId],
	);
	const trail = await path.query<{ kind: string; data: unknown }>(
		"SELECT kind, data FROM trail WHERE account_id = $1 ORDER BY seq",
		[accountId],
	);
	const forget = await path.query<{ fact_id: string }>(
		"SELECT fact_id FROM task_inbox WHERE account_id = $1 AND kind = 'forget'",
		[accountId],
	);
	return {
		tasks,
		messages,
		creditsTaken: Number(credits?.n ?? 0),
		actions: await actionsOf(path, accountId),
		trail,
		sends: sendsOf(path.workerLog, accountId),
		forgetList: forget.map((row) => row.fact_id),
		facts: input.facts,
		modelRequests: modelRequestsOf(path, input),
	};
}
