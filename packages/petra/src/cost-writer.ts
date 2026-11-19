// The cost writer and its reader (docs/ARCHITECTURE.md, sections 7.2 and 7.6, requirements S1 to S3 and S8).
// Only Petra uses it. Each method is one short transaction that names the account.
// The costs package (packages/costs) holds the rules. This module only has the SQL.
import type { Database, Transaction } from "@tensquads/core";

// One cost row. The shape is the shape of NewCost in packages/costs.
export interface CostRow {
	sourceRef: string;
	taskId: string | null;
	attemptNo: number | null;
	kind: string;
	provider: string;
	model: string;
	units: number;
	unit: string;
	unitPrice: number;
	amount: number;
	divided: boolean;
	period: string | null;
	at: string;
}

export interface CostWriter {
	// A row that is there does not change. The costs only get new rows (section 7.1).
	addCost(row: CostRow): Promise<void>;
	// One row for each read of a trail by a super admin (requirement S8). A read id that comes again changes nothing.
	addAdminRead(read: { readId: string; adminRef: string; taskId: string; at: string }): Promise<void>;
}

export interface CostReader {
	// The newest price with a start at or before the time (requirement S2), or undefined.
	unitPrice(price: { provider: string; model: string; unit: string; at: string }): Promise<number | undefined>;
	// The sum of the cost rows of the task, over all its attempts. No column holds it (requirement S3).
	taskCost(taskId: string): Promise<number>;
}

export function costWriter(database: Database, accountId: string): CostWriter & CostReader {
	const run = <T>(work: (tx: Transaction) => Promise<T>) => database.transaction({ role: "petra", accountId }, work);
	return {
		addCost: (row) =>
			run(async (tx) => {
				await tx.query(
					`INSERT INTO costs (account_id, source_ref, task_id, attempt_no, kind, provider, model, units, unit,
					 unit_price, amount, divided, period, at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT DO NOTHING`,
					[
						accountId,
						row.sourceRef,
						row.taskId,
						row.attemptNo,
						row.kind,
						row.provider,
						row.model,
						row.units,
						row.unit,
						row.unitPrice,
						row.amount,
						row.divided,
						row.period,
						row.at,
					],
				);
			}),
		addAdminRead: (read) =>
			run(async (tx) => {
				await tx.query(
					`INSERT INTO admin_reads (account_id, read_id, admin_ref, task_id, at)
					 VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
					[accountId, read.readId, read.adminRef, read.taskId, read.at],
				);
			}),
		unitPrice: (price) =>
			run(async (tx) => {
				const rows = await tx.query<{ price: string }>(
					`SELECT price FROM unit_prices WHERE provider = $1 AND model = $2 AND unit = $3 AND starts_at <= $4
					 ORDER BY starts_at DESC LIMIT 1`,
					[price.provider, price.model, price.unit, price.at],
				);
				return rows[0] ? Number(rows[0].price) : undefined;
			}),
		taskCost: (taskId) =>
			run(async (tx) => {
				const rows = await tx.query<{ amount: string | null }>(
					"SELECT sum(amount) AS amount FROM costs WHERE task_id = $1",
					[taskId],
				);
				return Number(rows[0]?.amount ?? 0);
			}),
	};
}

// The trail read of a super admin (section 6.5). Petra records the read before she gives the rows.
export async function adminTrailRead<Row>(
	deps: { addAdminRead: CostWriter["addAdminRead"]; taskTrail: (taskId: string) => Promise<Row[]> },
	read: { readId: string; adminRef: string; taskId: string; at: string },
): Promise<Row[]> {
	await deps.addAdminRead(read);
	return deps.taskTrail(read.taskId);
}
