// The transaction logic of the database port, with no driver.
// The Postgres and Neon adapters give a client of their driver. They share this code through core,
// because a plug-in does not import another plug-in (requirement C2).
import type { Database, DatabaseScope, Transaction } from "./ports.js";

// The part of a driver client that the transaction logic uses. The pg Client has this shape.
export interface SqlClient {
	connect(): Promise<unknown>;
	query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
	end(): Promise<void>;
	on(event: "error", listener: (error: Error) => void): unknown;
}

// One connection string for each runtime role. Each login user is a member of only its role.
export interface SqlConnections {
	petra?: string;
	platform?: string;
	adminViews?: string;
}

const ROLES = {
	petra: { name: "ts_petra", key: "petra" },
	platform: { name: "ts_platform", key: "platform" },
	"admin views": { name: "ts_admin_views", key: "adminViews" },
} as const;

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

// One transaction is one short connection. A Durable Object must not keep a socket between requests.
export function sqlDatabase(connections: SqlConnections, newClient: (url: string) => SqlClient): Database {
	async function transaction<T>(scope: DatabaseScope, work: (tx: Transaction) => Promise<T>): Promise<T> {
		const role = ROLES[scope.role];
		const url = connections[role.key];
		if (!url) {
			throw new Error(`The database adapter has no connection for the role "${scope.role}".`);
		}
		const client = newClient(url);
		let ending = false;
		let lost: Error | undefined;
		// The socket can close after end(). That is not an error of the transaction.
		client.on("error", (error) => {
			if (!ending) lost = error;
		});
		await client.connect();
		try {
			// The start of the transaction is one round trip: a simple query with three statements. A statement with
			// parameters cannot be in a list, so the account id is a literal, with each quote doubled. The server has
			// standard_conforming_strings on, so this is the full escape.
			const account =
				scope.role === "petra" ? `; SELECT set_config('app.account_id', ${literal(scope.accountId)}, true)` : "";
			await client.query(`BEGIN; SET LOCAL ROLE ${role.name}${account}`);
			const tx: Transaction = {
				query: async <Row>(sql: string, params: readonly unknown[] = []) => {
					if (lost) throw lost;
					return (await client.query(sql, [...params])).rows as Row[];
				},
			};
			const result = await work(tx);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			if (!lost) await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			ending = true;
			await client.end().catch(() => undefined);
		}
	}
	return { transaction, close: async () => {} };
}
