#!/usr/bin/env node

// Runs the migrations in db/ in the sequence of their numbers.
// Each migration runs one time, in one transaction. The table schema_migrations records it.
// It connects with DATABASE_URL, which must use the owner role of the database.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";

const DB_DIR = join(import.meta.dirname, "..", "db");
const FILE_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

const url = process.env.DATABASE_URL;
if (!url) {
	console.error("db:migrate: set DATABASE_URL to a connection with the owner role of the database.");
	process.exit(1);
}

const files = readdirSync(DB_DIR)
	.filter((name) => FILE_NAME.test(name))
	.sort();

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
	await client.query(
		"CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())",
	);
	const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((row) => row.name));
	for (const name of files) {
		if (done.has(name)) {
			continue;
		}
		await client.query("BEGIN");
		try {
			await client.query(readFileSync(join(DB_DIR, name), "utf8"));
			await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			console.error(`db:migrate: ${name} failed: ${error.message}`);
			process.exit(1);
		}
		console.log(`db:migrate: applied ${name}`);
	}
	console.log(`db:migrate: ${files.length} migrations, ${files.length - done.size} new.`);
} finally {
	await client.end();
}
