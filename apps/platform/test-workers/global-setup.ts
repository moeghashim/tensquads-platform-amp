// Runs in Node before the Workers tests. It empties the tables, because the tests use the fixed
// accounts of the identity test adapter. It uses the owner role of the test database.
import pg from "pg";

export default async function setup(): Promise<void> {
	const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();
	try {
		await client.query("TRUNCATE accounts, admin_commands, unit_prices, shared_costs CASCADE");
	} finally {
		await client.end();
	}
}
