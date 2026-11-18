// The database port with a connection to Neon. It uses pg, as the task 01 report recommends.
// Neon needs TLS. Use the direct connection string of a branch, not the pooler, because the pooler
// does not keep SET LOCAL ROLE in a transaction in every mode.
// If pg fails on Neon (SP-A7, not tested yet), this adapter changes to the Neon driver, with the same contract tests.
import { type Database, type Plugin, ports, type SqlConnections, sqlDatabase } from "@tensquads/core";
import pg from "pg";

export function neonDatabase(connections: SqlConnections): Database {
	return sqlDatabase(connections, (url) => new pg.Client({ connectionString: url, ssl: true }));
}

// The plug-in row for a plug-in list.
export function neonAdapter(connections: SqlConnections): Plugin {
	return {
		name: "database-neon",
		provides: [ports.database],
		needs: [],
		apply: (ctx) => {
			const database = neonDatabase(connections);
			ctx.provide(ports.database, database);
			ctx.onRemove(() => database.close());
		},
	};
}
