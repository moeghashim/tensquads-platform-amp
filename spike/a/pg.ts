// SP-A7: one transaction with SET LOCAL and one insert, with each driver.
import { Pool as NeonPool } from "@neondatabase/serverless";
import pg from "pg";
import postgres from "postgres";

interface PgEnv {
	PG_URL: string;
	HYPERDRIVE?: Hyperdrive;
}

type Outcome = { ok: boolean; rows?: number; otherAccountRows?: number; ms?: number; error?: string };

async function timed(run: () => Promise<Omit<Outcome, "ok" | "ms">>): Promise<Outcome> {
	const started = Date.now();
	try {
		return { ok: true, ...(await run()), ms: Date.now() - started };
	} catch (error) {
		return { ok: false, error: String((error as Error).message ?? error).slice(0, 200), ms: Date.now() - started };
	}
}

async function withPg(url: string, where: string, driver: string) {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		await client.query("BEGIN");
		await client.query("SET LOCAL ROLE ts_petra");
		await client.query("SELECT set_config('app.account_id', 'acct-a', true)");
		await client.query("INSERT INTO spike_rows (account_id, note) VALUES ('acct-a', $1)", [`${driver} ${where}`]);
		const mine = await client.query("SELECT count(*)::int AS n FROM spike_rows");
		await client.query("COMMIT");
		await client.query("BEGIN");
		await client.query("SET LOCAL ROLE ts_petra");
		await client.query("SELECT set_config('app.account_id', 'acct-b', true)");
		const other = await client.query("SELECT count(*)::int AS n FROM spike_rows");
		await client.query("COMMIT");
		return { rows: mine.rows[0].n as number, otherAccountRows: other.rows[0].n as number };
	} finally {
		await client.end();
	}
}

export async function pgTest(env: PgEnv, where: string): Promise<Record<string, Outcome>> {
	const result: Record<string, Outcome> = {};
	result["pg (cloudflare:sockets)"] = await timed(() => withPg(env.PG_URL, where, "pg"));
	result.postgres = await timed(async () => {
		const sql = postgres(env.PG_URL, { max: 1, fetch_types: false });
		try {
			const mine = await sql.begin(async (tx) => {
				await tx`SET LOCAL ROLE ts_petra`;
				await tx`SELECT set_config('app.account_id', 'acct-a', true)`;
				await tx`INSERT INTO spike_rows (account_id, note) VALUES ('acct-a', ${`postgres ${where}`})`;
				return tx`SELECT count(*)::int AS n FROM spike_rows`;
			});
			const other = await sql.begin(async (tx) => {
				await tx`SET LOCAL ROLE ts_petra`;
				await tx`SELECT set_config('app.account_id', 'acct-b', true)`;
				return tx`SELECT count(*)::int AS n FROM spike_rows`;
			});
			return { rows: mine[0]!.n as number, otherAccountRows: other[0]!.n as number };
		} finally {
			await sql.end();
		}
	});
	result["@neondatabase/serverless (Pool)"] = await timed(async () => {
		const pool = new NeonPool({ connectionString: env.PG_URL });
		try {
			const client = await pool.connect();
			await client.query("BEGIN");
			await client.query("SET LOCAL ROLE ts_petra");
			await client.query("SELECT set_config('app.account_id', 'acct-a', true)");
			const r = await client.query("SELECT count(*)::int AS n FROM spike_rows");
			await client.query("COMMIT");
			client.release();
			return { rows: r.rows[0].n as number };
		} finally {
			await pool.end();
		}
	});
	if (env.HYPERDRIVE !== undefined) {
		const hyperdrive = env.HYPERDRIVE;
		result["pg through Hyperdrive"] = await timed(() => withPg(hyperdrive.connectionString, where, "hyperdrive"));
	}
	return result;
}
