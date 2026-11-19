// The night writer and its reader (docs/ARCHITECTURE.md, sections 7.7, 7.8 and 10.1).
// Only Petra uses it. Each method is one short transaction that names the account.
// The night job (night.ts) holds the sequence. This module only has the SQL.
import type { Database, Transaction } from "@tensquads/core";

const ENDED = "('done', 'failed', 'cancelled')";

export interface TaskState {
	id: string;
	status: string;
}

// The cleaned text of a fact or of a core item that stays (section 7.8).
export interface CleanedRow {
	id: string;
	text: string;
	// The regular text for the search column of a fact. A core item has no search column.
	search?: string;
}

export interface CustomerCleaning {
	customerRef: string;
	taskIds: readonly string[];
	facts: readonly CleanedRow[];
	core: readonly CleanedRow[];
	// The cleaned text of each fact and core item of the customer, for each brief that names its id.
	briefs: readonly CleanedRow[];
	at: string;
}

// Sets the text of each brief entry with the id. The id and the other entries stay.
const BRIEF_ENTRY = `UPDATE tasks SET brief = jsonb_set(brief, '{facts}', (
	SELECT jsonb_agg(CASE WHEN f ->> 'id' = $1::text THEN jsonb_set(f, '{text}', to_jsonb($2::text)) ELSE f END
	ORDER BY i) FROM jsonb_array_elements(brief -> 'facts') WITH ORDINALITY AS e(f, i)))
	WHERE brief -> 'facts' @> jsonb_build_array(jsonb_build_object('id', $1::text))`;

const keys = (rows: { blob_key: string }[]) => rows.map((row) => row.blob_key);

export function nightWriter(database: Database, accountId: string) {
	const run = <T>(work: (tx: Transaction) => Promise<T>) => database.transaction({ role: "petra", accountId }, work);
	return {
		timeZone: () =>
			run(async (tx) => {
				const rows = await tx.query<{ time_zone: string }>("SELECT time_zone FROM accounts WHERE id = $1", [
					accountId,
				]);
				return rows[0]?.time_zone ?? "UTC";
			}),
		// The messages of the owner to Petra in a time range. A message of a customer has a customer reference.
		ownerMessages: (from: string, to: string) =>
			run((tx) =>
				tx.query<{ id: string; text: string }>(
					`SELECT source_ref AS id, body ->> 'text' AS text FROM messages
					 WHERE direction = 'in' AND sender = 'owner' AND customer_ref IS NULL AND NOT hidden
					 AND at >= $1 AND at < $2 AND body ->> 'text' IS NOT NULL ORDER BY seq`,
					[from, to],
				),
			),
		tasksWithFact: (factId: string) =>
			run((tx) =>
				tx.query<TaskState>(
					`SELECT id, status FROM tasks
					 WHERE brief -> 'facts' @> jsonb_build_array(jsonb_build_object('id', $1::text)) ORDER BY id`,
					[factId],
				),
			),
		customerTasks: (customerRef: string) =>
			run((tx) =>
				tx.query<TaskState>("SELECT id, status FROM tasks WHERE customer_ref = $1 ORDER BY id", [customerRef]),
			),
		// Step 2 of section 7.7: each pending approval of the tasks is rejected, and its action too.
		rejectPending: (taskIds: readonly string[], at: string) =>
			run(async (tx) => {
				await tx.query(
					`UPDATE approvals SET status = 'rejected', decided_by = 'deletion', decided_at = $2
					 WHERE task_id = ANY($1::text[]) AND status = 'pending'`,
					[taskIds, at],
				);
				await tx.query(
					`UPDATE actions SET status = 'rejected', done_at = $2 WHERE task_id = ANY($1::text[]) AND status = 'pending'`,
					[taskIds, at],
				);
			}),
		// The tasks with an action that is "started" (step 3 of section 7.7).
		startedTasks: (taskIds: readonly string[]) =>
			run(async (tx) => {
				const rows = await tx.query<{ task_id: string }>(
					"SELECT DISTINCT task_id FROM actions WHERE task_id = ANY($1::text[]) AND status = 'started'",
					[taskIds],
				);
				return new Set(rows.map((row) => row.task_id));
			}),
		journalCopies: (taskIds: readonly string[]) =>
			run(async (tx) =>
				keys(
					await tx.query<{ blob_key: string }>(
						"SELECT blob_key FROM journal_copies WHERE task_id = ANY($1::text[])",
						[taskIds],
					),
				),
			),
		// The drafts and the journal copies of the tasks.
		taskFiles: (taskIds: readonly string[]) =>
			run(async (tx) =>
				keys(
					await tx.query<{ blob_key: string }>(
						`SELECT blob_key FROM draft_files WHERE task_id = ANY($1::text[])
						 UNION ALL SELECT blob_key FROM journal_copies WHERE task_id = ANY($1::text[])`,
						[taskIds],
					),
				),
			),
		// The drafts and the journal copies of each task with a final status and no action that is "started".
		endedTaskFiles: () =>
			run(async (tx) =>
				keys(
					await tx.query<{ blob_key: string }>(
						`WITH ended AS (
							SELECT id FROM tasks t WHERE status IN ${ENDED}
							AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.task_id = t.id AND a.status = 'started')
						)
						SELECT blob_key FROM draft_files WHERE task_id IN (SELECT id FROM ended)
						UNION ALL SELECT blob_key FROM journal_copies WHERE task_id IN (SELECT id FROM ended)`,
					),
				),
			),
		deleteFiles: (blobKeys: readonly string[]) =>
			run(async (tx) => {
				await tx.query("DELETE FROM draft_files WHERE blob_key = ANY($1::text[])", [blobKeys]);
				await tx.query("DELETE FROM journal_copies WHERE blob_key = ANY($1::text[])", [blobKeys]);
			}),
		deleteForgottenFacts: (ids: readonly string[]) =>
			run(async (tx) => {
				await tx.query("DELETE FROM facts WHERE source_ref = ANY($1::text[]) AND status = 'forgotten'", [ids]);
			}),
		// Each customer whose newest message to the business is older than the time (section 7.8).
		dueCustomers: (before: string) =>
			run(async (tx) => {
				const rows = await tx.query<{ customer_ref: string }>(
					`SELECT customer_ref FROM messages WHERE customer_ref IS NOT NULL AND direction = 'in'
					 GROUP BY customer_ref HAVING max(at) < $1 ORDER BY customer_ref`,
					[before],
				);
				return rows.map((row) => row.customer_ref);
			}),
		// The names (the field "name" of the payload of an event) and the addresses (the sender) of a customer.
		customerData: (customerRef: string) =>
			run(async (tx) => {
				const rows = await tx.query<{ name: string | null; sender: string | null }>(
					`SELECT payload -> 'payload' ->> 'name' AS name, payload ->> 'sender' AS sender FROM events
					 WHERE customer_ref = $1`,
					[customerRef],
				);
				const present = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => !!v))];
				return { names: present(rows.map((row) => row.name)), addresses: present(rows.map((row) => row.sender)) };
			}),
		// The facts of a customer that the owner approved or promoted, and that are not cleaned yet.
		keptFacts: (customerRef: string) =>
			run((tx) =>
				tx.query<CleanedRow>(
					`SELECT source_ref AS id, text FROM facts f WHERE customer_ref = $1 AND cleaned_at IS NULL
					 AND (approved_by_owner OR EXISTS (SELECT 1 FROM core_items c WHERE c.fact_ref = f.source_ref))`,
					[customerRef],
				),
			),
		// Each fact of a customer that is not cleaned yet. The night job deletes or cleans each one.
		customerFacts: (customerRef: string) =>
			run((tx) =>
				tx.query<CleanedRow>(
					"SELECT source_ref AS id, text FROM facts WHERE customer_ref = $1 AND cleaned_at IS NULL",
					[customerRef],
				),
			),
		// The core items that were made from a fact of the customer, and that are not cleaned yet.
		customerCore: (customerRef: string) =>
			run((tx) =>
				tx.query<CleanedRow>(
					`SELECT source_ref AS id, text FROM core_items WHERE cleaned_at IS NULL
					 AND (customer_ref = $1 OR fact_ref IN (SELECT source_ref FROM facts WHERE customer_ref = $1))`,
					[customerRef],
				),
			),
		// Each place of the table of section 7.8, in one transaction. A row whose text is now empty loses its reference.
		cleanCustomer: (c: CustomerCleaning) =>
			run(async (tx) => {
				const [ref, ids, at] = [c.customerRef, c.taskIds, c.at];
				await tx.query(
					`UPDATE proposals SET text = '' WHERE status <> 'approved' AND text <> '' AND EXISTS (
						SELECT 1 FROM jsonb_array_elements_text(evidence) e(id) JOIN messages m ON m.source_ref = e.id
						WHERE m.customer_ref = $1 OR m.task_id = ANY($2::text[]))`,
					[ref, ids],
				);
				await tx.query(
					`UPDATE messages SET body = '{}', sender = '', search = NULL, cleaned_at = $3, customer_ref = NULL
					 WHERE customer_ref = $1 OR task_id = ANY($2::text[])`,
					[ref, ids, at],
				);
				await tx.query("UPDATE events SET payload = '{}', customer_ref = NULL WHERE customer_ref = $1", [ref]);
				await tx.query("UPDATE tasks SET brief = '{}', customer_ref = NULL WHERE id = ANY($1::text[])", [ids]);
				await tx.query("UPDATE task_inbox SET body = NULL WHERE task_id = ANY($1::text[])", [ids]);
				await tx.query("UPDATE actions SET content = '{}', answer = NULL WHERE task_id = ANY($1::text[])", [ids]);
				await tx.query("DELETE FROM notes WHERE task_id = ANY($2::text[]) OR customer_ref = $1", [ref, ids]);
				for (const fact of c.facts) {
					await tx.query(
						"UPDATE facts SET text = $2, search = to_tsvector('simple', $3), cleaned_at = $4 WHERE source_ref = $1",
						[fact.id, fact.text, fact.search ?? "", at],
					);
				}
				await tx.query("DELETE FROM facts WHERE customer_ref = $1 AND cleaned_at IS NULL", [ref]);
				// A brief of any task can hold a copy of a fact or a core item of the customer.
				for (const entry of c.briefs) await tx.query(BRIEF_ENTRY, [entry.id, entry.text]);
				for (const item of c.core) {
					await tx.query("UPDATE core_items SET text = $2, cleaned_at = $3 WHERE source_ref = $1", [
						item.id,
						item.text,
						at,
					]);
				}
			}),
	};
}

export type NightWriter = ReturnType<typeof nightWriter>;
