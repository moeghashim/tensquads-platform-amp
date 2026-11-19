// A case from the trail of a task (requirement E4). This program joins the evals package and the clean function of
// the memory. It reads the trail only through the admin trail call, so admin_reads records each read (D22).
import { caseFromTrail, type TrailCaseInput, type TrailCaseOutcome, type TrailCaseRow } from "@tensquads/evals";
import { cleanCustomerText } from "@tensquads/memory";

export type TaskCaseInput = Omit<TrailCaseInput, "clean">;

export function caseFromRows(input: TaskCaseInput): TrailCaseOutcome {
	return caseFromTrail({ ...input, clean: cleanCustomerText });
}

// A call of the admin API as the super admin.
export type AdminGet = (path: string) => Promise<Response>;

async function rowsOf<Row>(response: Response, what: string): Promise<Row[]> {
	if (!response.ok) throw new Error(`The admin call for ${what} failed with the status ${response.status}.`);
	return ((await response.json()) as { rows: Row[] }).rows;
}

// A task is open when the operations view lists it as open, or with an approval that waits.
async function isOpen(get: AdminGet, accountId: string, taskId: string): Promise<boolean> {
	const rows = await rowsOf<{ item: string; account_id: string | null; ref: string | null }>(
		await get("/v1/admin/views/operations"),
		"the operations view",
	);
	return rows.some(
		(row) =>
			row.account_id === accountId &&
			((row.item === "open task" && row.ref === taskId) ||
				(row.item === "approval that waits" && row.ref?.startsWith(`${taskId}/`) === true)),
	);
}

export async function caseFromTask(
	get: AdminGet,
	input: Omit<TaskCaseInput, "rows" | "open"> & { accountId: string; readId: string },
): Promise<TrailCaseOutcome> {
	const { accountId, readId, ...rest } = input;
	const path = `/v1/admin/accounts/${encodeURIComponent(accountId)}/tasks/${encodeURIComponent(rest.taskId)}/trail`;
	const response = await get(`${path}?readId=${encodeURIComponent(readId)}`);
	// A trail that was deleted has no rows. A task that never existed has none too.
	const rows = response.status === 404 ? [] : await rowsOf<TrailCaseRow>(response, "the trail");
	if (rows.length === 0) return caseFromRows({ ...rest, rows, open: false });
	return caseFromRows({ ...rest, rows, open: await isOpen(get, accountId, rest.taskId) });
}
