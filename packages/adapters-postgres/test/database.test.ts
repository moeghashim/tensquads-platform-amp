import assert from "node:assert/strict";
import test from "node:test";
import type { SqlConnections } from "@tensquads/core";
import { ports, startSystem } from "@tensquads/core";
import { databaseContract } from "@tensquads/core/contract-tests";

import { postgresAdapter, postgresDatabase } from "../src/index.js";

// The test needs a Postgres with the migrations and the login users (README.md, "The database").
const ownerUrl = process.env.DATABASE_URL;
const password = process.env.DB_USER_PASSWORD;
if (!ownerUrl || !password) {
	throw new Error("Set DATABASE_URL and DB_USER_PASSWORD. Run npm run db:migrate and npm run db:users first.");
}

function loginUrl(user: string): string {
	const url = new URL(ownerUrl as string);
	url.username = user;
	url.password = password as string;
	return url.toString();
}

const connections: SqlConnections = {
	petra: loginUrl("ts_petra_login"),
	platform: loginUrl("ts_platform_login"),
	adminViews: loginUrl("ts_admin_views_login"),
};

databaseContract("database-postgres", async () => postgresDatabase(connections));

test("the Postgres adapter is one row of a plug-in list", async () => {
	const system = await startSystem([postgresAdapter(connections)]);
	const rows = await system
		.port(ports.database)
		.transaction({ role: "platform" }, (tx) => tx.query<{ role: string }>("SELECT current_role AS role"));
	assert.deepEqual(rows, [{ role: "ts_platform" }]);
	await system.stop();
});

test("a role with no connection fails with a clear message", async () => {
	const database = postgresDatabase({ platform: connections.platform });
	await assert.rejects(
		database.transaction({ role: "petra", accountId: "a" }, async () => undefined),
		/no connection for the role "petra"/,
	);
});
