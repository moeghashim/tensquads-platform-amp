// The platform writer and its reader (docs/ARCHITECTURE.md, section 3.3).
// Only the Platform object uses it. It writes the tables that have no account.
// Each write has a natural key, so a second call with the same key changes nothing (requirement P6).
import type { AdminView } from "@tensquads/contracts";
import type { Database, Transaction } from "@tensquads/core";

export interface AdminCommandRow {
	commandId: string;
	kind: string;
	adminRef: string;
	payload: unknown;
	status: "received" | "done";
	answer: unknown;
}

export interface NewAccount {
	id: string;
	name: string;
	timeZone: string;
	language: "en" | "ar";
	modelProfile: "real" | "test";
	at: string;
}

export interface NewSharedCost {
	id: string;
	period: string;
	kind: "storage" | "database" | "worker";
	provider: string;
	amount: number;
	supersedes: string | null;
	setBy: string;
	at: string;
}

// One part of a shared cost for one account (section 7.6).
export interface SharedCostPart {
	accountId: string;
	usage: number;
	amount: number;
}

export interface PlatformWriter {
	// The first write of an admin command. Returns the row, which can be "done" from an earlier run.
	receiveAdminCommand(command: {
		commandId: string;
		kind: string;
		payload: unknown;
		adminRef: string;
		at: string;
	}): Promise<AdminCommandRow>;
	finishAdminCommand(commandId: string, answer: unknown): Promise<void>;
	addAccount(account: NewAccount): Promise<void>;
	addOwner(owner: { accountId: string; identityRef: string; at: string }): Promise<void>;
	// One row of the price list (requirement S2). A row with the same key changes nothing.
	addUnitPrice(price: {
		provider: string;
		model: string;
		unit: string;
		price: number;
		startsAt: string;
	}): Promise<void>;
	addSharedCost(cost: NewSharedCost): Promise<void>;
	// All the parts of one shared cost, in one transaction (requirement S4). Parts that are there do not change.
	addSharedCostParts(sharedCostId: string, parts: readonly SharedCostPart[]): Promise<void>;
}

export interface PlatformReader {
	receivedAdminCommands(): Promise<AdminCommandRow[]>;
	accountExists(accountId: string): Promise<boolean>;
	// Each account with its time zone, for the schedule of the night job (section 10.1).
	accounts(): Promise<{ id: string; timeZone: string }[]>;
	sharedCost(
		id: string,
	): Promise<
		{ period: string; kind: NewSharedCost["kind"]; provider: string; supersededBy: string | null } | undefined
	>;
	// The parts of a shared cost, in the sequence of the account ids. Empty when none is written.
	sharedCostParts(sharedCostId: string): Promise<SharedCostPart[]>;
	// The usage of each account that existed in the period, from the usage view (section 7.6).
	periodUsage(period: string): Promise<{ accountId: string; usage: number }[]>;
	// The rows of one view of the schema admin. The value of a credit goes to the view as a setting.
	adminView(name: AdminView, creditValueMicros: number): Promise<Record<string, unknown>[]>;
}

interface AdminRow {
	command_id: string;
	kind: string;
	admin_ref: string;
	payload: unknown;
	status: "received" | "done";
	answer: unknown;
}

const toRow = (row: AdminRow): AdminCommandRow => ({
	commandId: row.command_id,
	kind: row.kind,
	adminRef: row.admin_ref,
	payload: row.payload,
	status: row.status,
	answer: row.answer,
});

export function platformWriter(database: Database): PlatformWriter & PlatformReader {
	const run = <T>(work: (tx: Transaction) => Promise<T>) => database.transaction({ role: "platform" }, work);
	return {
		receiveAdminCommand: (command) =>
			run(async (tx) => {
				await tx.query(
					`INSERT INTO admin_commands (command_id, kind, payload, admin_ref, status, at)
					 VALUES ($1, $2, $3, $4, 'received', $5) ON CONFLICT DO NOTHING`,
					[command.commandId, command.kind, JSON.stringify(command.payload), command.adminRef, command.at],
				);
				const rows = await tx.query<AdminRow>(
					"SELECT command_id, kind, admin_ref, payload, status, answer FROM admin_commands WHERE command_id = $1",
					[command.commandId],
				);
				return toRow(rows[0]!);
			}),
		finishAdminCommand: (commandId, answer) =>
			run(async (tx) => {
				await tx.query(
					"UPDATE admin_commands SET status = 'done', answer = $2 WHERE command_id = $1 AND status = 'received'",
					[commandId, JSON.stringify(answer)],
				);
			}),
		addAccount: (account) =>
			run(async (tx) => {
				await tx.query(
					`INSERT INTO accounts (id, name, time_zone, language, model_profile, created_at)
					 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
					[account.id, account.name, account.timeZone, account.language, account.modelProfile, account.at],
				);
			}),
		addOwner: (owner) =>
			run(async (tx) => {
				await tx.query(
					"INSERT INTO owners (account_id, identity_ref, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
					[owner.accountId, owner.identityRef, owner.at],
				);
			}),
		addUnitPrice: (price) =>
			run(async (tx) => {
				await tx.query(
					`INSERT INTO unit_prices (provider, model, unit, starts_at, price) VALUES ($1, $2, $3, $4, $5)
					 ON CONFLICT DO NOTHING`,
					[price.provider, price.model, price.unit, price.startsAt, price.price],
				);
			}),
		addSharedCost: (cost) =>
			run(async (tx) => {
				await tx.query(
					`INSERT INTO shared_costs (id, period, kind, provider, amount, supersedes, set_by, at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
					[cost.id, cost.period, cost.kind, cost.provider, cost.amount, cost.supersedes, cost.setBy, cost.at],
				);
			}),
		addSharedCostParts: (sharedCostId, parts) =>
			run(async (tx) => {
				for (const part of parts) {
					await tx.query(
						`INSERT INTO shared_cost_parts (shared_cost_id, account_id, usage, amount) VALUES ($1, $2, $3, $4)
						 ON CONFLICT DO NOTHING`,
						[sharedCostId, part.accountId, part.usage, part.amount],
					);
				}
			}),
		sharedCost: (id) =>
			run(async (tx) => {
				const rows = await tx.query<{
					period: string;
					kind: NewSharedCost["kind"];
					provider: string;
					supersededBy: string | null;
				}>(
					`SELECT period, kind, provider, (SELECT id FROM shared_costs later WHERE later.supersedes = shared_costs.id)
					 AS "supersededBy" FROM shared_costs WHERE id = $1`,
					[id],
				);
				return rows[0];
			}),
		sharedCostParts: (sharedCostId) =>
			run(async (tx) => {
				const rows = await tx.query<{ accountId: string; usage: string; amount: string }>(
					`SELECT account_id AS "accountId", usage, amount FROM shared_cost_parts
					 WHERE shared_cost_id = $1 ORDER BY account_id`,
					[sharedCostId],
				);
				return rows.map((row) => ({
					accountId: row.accountId,
					usage: Number(row.usage),
					amount: Number(row.amount),
				}));
			}),
		periodUsage: (period) =>
			run(async (tx) => {
				const rows = await tx.query<{ accountId: string; usage: string }>(
					`SELECT accounts.id AS "accountId", coalesce(used.rows, 0) AS usage FROM accounts
					 LEFT JOIN (SELECT account_id, sum(cost_rows) AS rows FROM admin.usage WHERE period = $1 GROUP BY account_id)
					 AS used ON used.account_id = accounts.id
					 WHERE accounts.created_at < ((($1 || '-01')::date + interval '1 month') AT TIME ZONE 'UTC')
					 ORDER BY accounts.id`,
					[period],
				);
				return rows.map((row) => ({ accountId: row.accountId, usage: Number(row.usage) }));
			}),
		// The role of the views reads only the views (section 3.3). The name comes from the list ADMIN_VIEWS.
		adminView: (name, creditValueMicros) =>
			database.transaction({ role: "admin views" }, async (tx) => {
				await tx.query("SELECT set_config('app.credit_value_micros', $1, true)", [String(creditValueMicros)]);
				const rows = await tx.query<{ row: Record<string, unknown> }>(
					`SELECT to_jsonb(v) AS row FROM admin.${name} v ORDER BY to_jsonb(v)::text`,
				);
				return rows.map((item) => item.row);
			}),
		receivedAdminCommands: () =>
			run(async (tx) => {
				const rows = await tx.query<AdminRow>(
					"SELECT command_id, kind, admin_ref, payload, status, answer FROM admin_commands WHERE status = 'received' ORDER BY at, command_id",
				);
				return rows.map(toRow);
			}),
		accounts: () =>
			run((tx) =>
				tx.query<{ id: string; timeZone: string }>('SELECT id, time_zone AS "timeZone" FROM accounts ORDER BY id'),
			),
		accountExists: (accountId) =>
			run(async (tx) => (await tx.query("SELECT 1 FROM accounts WHERE id = $1", [accountId])).length > 0),
	};
}
