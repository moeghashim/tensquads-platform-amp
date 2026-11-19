// The platform writer and its reader (docs/ARCHITECTURE.md, section 3.3).
// Only the Platform object uses it. It writes the tables that have no account.
// Each write has a natural key, so a second call with the same key changes nothing (requirement P6).
import type { Database, Transaction } from "@tensquads/core";

export interface AdminCommandRow {
	commandId: string;
	kind: string;
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
}

export interface PlatformReader {
	receivedAdminCommands(): Promise<AdminCommandRow[]>;
	accountExists(accountId: string): Promise<boolean>;
	// Each account with its time zone, for the schedule of the night job (section 10.1).
	accounts(): Promise<{ id: string; timeZone: string }[]>;
}

interface AdminRow {
	command_id: string;
	kind: string;
	payload: unknown;
	status: "received" | "done";
	answer: unknown;
}

const toRow = (row: AdminRow): AdminCommandRow => ({
	commandId: row.command_id,
	kind: row.kind,
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
					"SELECT command_id, kind, payload, status, answer FROM admin_commands WHERE command_id = $1",
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
		receivedAdminCommands: () =>
			run(async (tx) => {
				const rows = await tx.query<AdminRow>(
					"SELECT command_id, kind, payload, status, answer FROM admin_commands WHERE status = 'received' ORDER BY at, command_id",
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
