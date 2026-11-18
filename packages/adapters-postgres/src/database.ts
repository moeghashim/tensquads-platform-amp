// The database port with a plain Postgres connection, through the pg driver (task 01 report, SP-A7).
// pg uses cloudflare:sockets in the Workers runtime and node:net in Node.
import { type Database, type Plugin, ports, type SqlConnections, sqlDatabase } from "@tensquads/core";
import pg from "pg";

export function postgresDatabase(connections: SqlConnections): Database {
	return sqlDatabase(connections, (url) => new pg.Client({ connectionString: url }));
}

// The plug-in row for a plug-in list.
export function postgresAdapter(connections: SqlConnections): Plugin {
	return {
		name: "database-postgres",
		provides: [ports.database],
		needs: [],
		apply: (ctx) => {
			const database = postgresDatabase(connections);
			ctx.provide(ports.database, database);
			ctx.onRemove(() => database.close());
		},
	};
}
