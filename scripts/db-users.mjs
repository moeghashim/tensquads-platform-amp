#!/usr/bin/env node

// Makes one login user for each runtime role, on a developer machine or in CI.
// Each user is a member of only its role. Staging makes its users in Neon, not with this script.
// It connects with DATABASE_URL (the owner role). DB_USER_PASSWORD gives the password of the three users.

import pg from "pg";

export const LOGIN_USERS = {
	ts_petra: "ts_petra_login",
	ts_platform: "ts_platform_login",
	ts_admin_views: "ts_admin_views_login",
};

const url = process.env.DATABASE_URL;
const password = process.env.DB_USER_PASSWORD;
if (!url || !password) {
	console.error("db:users: set DATABASE_URL (owner role) and DB_USER_PASSWORD.");
	process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
	const database = new URL(url).pathname.slice(1);
	for (const [role, user] of Object.entries(LOGIN_USERS)) {
		const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [user]);
		const verb = exists.rowCount === 0 ? "CREATE" : "ALTER";
		await client.query(`${verb} ROLE ${user} LOGIN NOINHERIT PASSWORD ${client.escapeLiteral(password)}`);
		await client.query(`GRANT ${role} TO ${user}`);
		await client.query(`GRANT CONNECT ON DATABASE ${client.escapeIdentifier(database)} TO ${user}`);
		console.log(`db:users: ${user} is a member of ${role}.`);
	}
} finally {
	await client.end();
}
