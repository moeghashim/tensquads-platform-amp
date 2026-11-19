// The memory writer and its reader (docs/ARCHITECTURE.md, sections 7.1 and 7.2).
// Only Petra uses it. Each method is one short transaction that names the account.
// The memory package (packages/memory) holds the rules and makes the text regular. This module only has the SQL.
import type { Database, Transaction } from "@tensquads/core";

import type { EventOrigin } from "./account-writer.js";

interface MemoryRow {
	id: string;
	text: string;
}

interface NewFactRow {
	sourceRef: string;
	page: string;
	text: string;
	// The regular text. The search column is to_tsvector('simple', search) (requirement M12).
	search: string;
	origin: EventOrigin;
	madeBy: string;
	customerRef: string | null;
	approvedByOwner: boolean;
	at: string;
}

interface NewNoteRow {
	sourceRef: string;
	bot: string;
	taskId: string;
	text: string;
	search: string;
	origin: EventOrigin;
	customerRef: string | null;
	at: string;
}

interface FactRow {
	id: string;
	page: string;
	text: string;
	origin: EventOrigin;
	status: "current" | "replaced" | "forgotten";
	forgottenAt: string | null;
	customerRef: string | null;
}

interface NewCoreRow {
	sourceRef: string;
	text: string;
	source: "owner" | "night job";
	factRef: string | null;
	customerRef: string | null;
	at: string;
}

interface NewProposalRow {
	week: string;
	n: number;
	kind: string;
	text: string;
	// Ids of messages only, never a text (section 7.2).
	evidence: readonly string[];
}

export interface MemoryWriter {
	addPage(page: { name: string; acceptsFrom: string; createdBy: string }): Promise<void>;
	addFact(fact: NewFactRow): Promise<void>;
	addNote(note: NewNoteRow): Promise<void>;
	// Adds the item only while the core has fewer active items than the limit. True when the item is there.
	addCoreItem(item: NewCoreRow, limit: number): Promise<boolean>;
	removeCoreItem(sourceRef: string): Promise<void>;
	forgetFact(id: string, at: string): Promise<void>;
	undoForget(id: string): Promise<void>;
	approveFact(id: string): Promise<void>;
	// A proposal of the night job has the status "pending". The owner approves with AddCoreItem.
	addProposal(proposal: NewProposalRow): Promise<void>;
}

export interface MemoryReader {
	pageAccepts(name: string): Promise<string | undefined>;
	fact(id: string): Promise<FactRow | undefined>;
	// The query is a text search query of words joined with "|". Only current facts.
	search(scope: {
		query: string;
		allPages: boolean;
		pages: readonly string[];
		notes: boolean;
		limit: number;
	}): Promise<MemoryRow[]>;
	activeCore(): Promise<MemoryRow[]>;
	forgottenFacts(before?: string): Promise<{ id: string; text: string; forgottenAt: string }[]>;
	weekProposals(week: string): Promise<{ evidence: string[] }[]>;
}

interface FactDbRow {
	source_ref: string;
	page: string;
	text: string;
	origin: EventOrigin;
	status: FactRow["status"];
	forgotten_at: Date | null;
	customer_ref: string | null;
}

// The facts of the pages and the notes, in one list by rank.
const SEARCH = `SELECT id, text FROM (
	SELECT source_ref AS id, text, ts_rank(search, q) AS rank, at FROM facts, to_tsquery('simple', $1) q
	WHERE status = 'current' AND search @@ q AND ($2 OR page = ANY($3::text[]))
	UNION ALL
	SELECT source_ref, text, ts_rank(search, q), at FROM notes, to_tsquery('simple', $1) q
	WHERE $4 AND status = 'current' AND search @@ q
) found ORDER BY rank DESC, at, id LIMIT $5`;

export function memoryWriter(database: Database, accountId: string): MemoryWriter & MemoryReader {
	const run = <T>(work: (tx: Transaction) => Promise<T>) => database.transaction({ role: "petra", accountId }, work);
	const exec = (sql: string, params: unknown[]) =>
		run(async (tx) => {
			await tx.query(sql, params);
		});
	return {
		addPage: (page) =>
			exec(
				`INSERT INTO pages (account_id, name, accepts_from, created_by) VALUES ($1, $2, $3, $4)
				 ON CONFLICT DO NOTHING`,
				[accountId, page.name, page.acceptsFrom, page.createdBy],
			),
		addFact: (fact) =>
			exec(
				`INSERT INTO facts (account_id, source_ref, page, text, origin, made_by, customer_ref, approved_by_owner,
				 status, at, search)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'current', $9, to_tsvector('simple', $10)) ON CONFLICT DO NOTHING`,
				[
					accountId,
					fact.sourceRef,
					fact.page,
					fact.text,
					fact.origin,
					fact.madeBy,
					fact.customerRef,
					fact.approvedByOwner,
					fact.at,
					fact.search,
				],
			),
		addNote: (note) =>
			exec(
				`INSERT INTO notes (account_id, source_ref, bot, task_id, text, origin, customer_ref, status, at, search)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, 'current', $8, to_tsvector('simple', $9)) ON CONFLICT DO NOTHING`,
				[
					accountId,
					note.sourceRef,
					note.bot,
					note.taskId,
					note.text,
					note.origin,
					note.customerRef,
					note.at,
					note.search,
				],
			),
		// One statement counts and adds, so the limit holds in one transaction (requirement M7).
		addCoreItem: (item, limit) =>
			run(async (tx) => {
				await tx.query(
					`INSERT INTO core_items (account_id, source_ref, text, source, fact_ref, customer_ref, status, at)
					 SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, 'active', $7::timestamptz
					 WHERE (SELECT count(*) FROM core_items WHERE status = 'active') < $8::int
					 ON CONFLICT DO NOTHING`,
					[accountId, item.sourceRef, item.text, item.source, item.factRef, item.customerRef, item.at, limit],
				);
				const rows = await tx.query("SELECT 1 FROM core_items WHERE source_ref = $1", [item.sourceRef]);
				return rows.length > 0;
			}),
		removeCoreItem: (sourceRef) =>
			exec("UPDATE core_items SET status = 'removed' WHERE source_ref = $1", [sourceRef]),
		forgetFact: (id, at) =>
			exec("UPDATE facts SET status = 'forgotten', forgotten_at = $2 WHERE source_ref = $1 AND status = 'current'", [
				id,
				at,
			]),
		undoForget: (id) =>
			exec(
				"UPDATE facts SET status = 'current', forgotten_at = NULL WHERE source_ref = $1 AND status = 'forgotten'",
				[id],
			),
		approveFact: (id) =>
			exec(
				`UPDATE facts SET approved_by_owner = true
				 WHERE source_ref = $1 AND EXISTS (SELECT 1 FROM core_items WHERE fact_ref = $1)`,
				[id],
			),
		addProposal: (proposal) =>
			exec(
				`INSERT INTO proposals (account_id, week, n, kind, text, evidence, status)
				 VALUES ($1, $2, $3, $4, $5, $6, 'pending') ON CONFLICT DO NOTHING`,
				[accountId, proposal.week, proposal.n, proposal.kind, proposal.text, JSON.stringify(proposal.evidence)],
			),
		weekProposals: (week) =>
			run((tx) =>
				tx.query<{ evidence: string[] }>("SELECT evidence FROM proposals WHERE week = $1 ORDER BY n", [week]),
			),
		pageAccepts: (name) =>
			run(async (tx) => {
				const rows = await tx.query<{ accepts_from: string }>("SELECT accepts_from FROM pages WHERE name = $1", [
					name,
				]);
				return rows[0]?.accepts_from;
			}),
		fact: (id) =>
			run(async (tx) => {
				const rows = await tx.query<FactDbRow>(
					`SELECT source_ref, page, text, origin, status, forgotten_at, customer_ref FROM facts
					 WHERE source_ref = $1`,
					[id],
				);
				const row = rows[0];
				if (!row) return undefined;
				return {
					id: row.source_ref,
					page: row.page,
					text: row.text,
					origin: row.origin,
					status: row.status,
					forgottenAt: row.forgotten_at ? row.forgotten_at.toISOString() : null,
					customerRef: row.customer_ref,
				};
			}),
		search: (scope) =>
			run((tx) => tx.query<MemoryRow>(SEARCH, [scope.query, scope.allPages, scope.pages, scope.notes, scope.limit])),
		activeCore: () =>
			run((tx) =>
				tx.query<MemoryRow>(
					"SELECT source_ref AS id, text FROM core_items WHERE status = 'active' ORDER BY at, source_ref",
				),
			),
		forgottenFacts: (before) =>
			run(async (tx) => {
				const rows = await tx.query<{ source_ref: string; text: string; forgotten_at: Date }>(
					`SELECT source_ref, text, forgotten_at FROM facts
					 WHERE status = 'forgotten' AND ($1::timestamptz IS NULL OR forgotten_at < $1::timestamptz)
					 ORDER BY forgotten_at, source_ref`,
					[before ?? null],
				);
				return rows.map((row) => ({
					id: row.source_ref,
					text: row.text,
					forgottenAt: row.forgotten_at.toISOString(),
				}));
			}),
	};
}
