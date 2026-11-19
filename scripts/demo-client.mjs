import pg from "pg";

// The client of the demos. It calls the Platform Worker as an owner or as the super admin.

// Sends one call. A call with a body is a POST. Returns the status and the JSON answer.
export async function request(base, path, token, body) {
	const response = await fetch(`${base}${path}`, {
		method: body ? "POST" : "GET",
		headers: { authorization: `Bearer ${token}` },
		body: body ? JSON.stringify(body) : undefined,
	});
	return { status: response.status, body: await response.json() };
}

// Makes the account of owner A and adds owner A. A command id that comes again changes nothing.
export async function setUpAccount(call, at) {
	await call("/v1/admin/commands", "super-admin", {
		type: "CreateAccount",
		commandId: "account-a",
		at,
		name: "Cafe A",
		timeZone: "Asia/Riyadh",
		language: "en",
		modelProfile: "test",
		initialCredits: 100,
	});
	await call("/v1/admin/commands", "super-admin", {
		type: "AddOwner",
		commandId: "account-a/owner-a",
		at,
		accountId: "account-a",
		identityRef: "owner-a",
	});
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Connects to the database of DATABASE_URL, as a developer reads it. A demo reads rows with it, and never writes.
export async function connectDatabase() {
	if (!process.env.DATABASE_URL) throw new Error("The setting DATABASE_URL is missing.");
	const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
	await db.connect();
	return db;
}

// Waits until the task has a final status, or for 30 seconds.
export async function waitForTaskEnd(call, taskId) {
	for (let i = 0; i < 600; i++) {
		const { status, body } = await call(`/v1/tasks/${taskId}`, "owner-a");
		if (status === 200 && ["done", "failed", "cancelled"].includes(body.status)) return;
		await sleep(50);
	}
}
