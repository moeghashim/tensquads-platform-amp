// The harness of the tests of the full path (task 04). The full path itself is in apps/evals, because the runner
// of evals uses it too (task 11). This harness adds the fixed account "account-a" and its owner.
// Each test file starts with no row of its account. The rows of other accounts, for example of the evals, stay.
import { spawn } from "node:child_process";
import { join } from "node:path";

import { LocalPath } from "../../evals/src/full-path.js";

export { PASS_KEY, type ProxiedCall, waitFor } from "../../evals/src/full-path.js";

export const AT = "2026-11-18T10:00:00.000Z";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const ACCOUNT = "account-a";
const OWNER_COMMAND = "account-a/owner-a";

export class FullPath extends LocalPath {
	// The vars are settings of the Worker for these tests, for example a short silent time.
	constructor(vars: Record<string, string> = {}) {
		super({ vars, killable: true });
	}

	override async start(): Promise<void> {
		await this.deleteAccount();
		await super.start();
	}

	// Deletes each row of account-a and its two admin commands. The test ids of the tasks are the same in each file,
	// and a task id is unique in the database. The replica role skips the foreign keys, so the order does not matter.
	private async deleteAccount(): Promise<void> {
		const tables = await this.query<{ table_name: string }>(
			`SELECT table_name FROM information_schema.columns
			 WHERE table_schema = 'public' AND column_name = 'account_id' AND table_name <> 'accounts'`,
		);
		const client = await this.db.connect();
		try {
			await client.query("BEGIN");
			await client.query("SET LOCAL session_replication_role = replica");
			for (const { table_name } of tables) {
				await client.query(`DELETE FROM "${table_name}" WHERE account_id = $1`, [ACCOUNT]);
			}
			await client.query("DELETE FROM accounts WHERE id = $1", [ACCOUNT]);
			await client.query("DELETE FROM admin_commands WHERE command_id = ANY($1)", [[ACCOUNT, OWNER_COMMAND]]);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	// The number of sends of the payment adapter for one action id.
	payments(actionId: string): number {
		return this.workerLog.split("\n").filter((line) => line.includes(`payment-test: send ${actionId}`)).length;
	}

	// Starts one more runner by hand, with a pass, as a second sandbox for one attempt.
	runRunner(pass: string): Promise<number> {
		const child = spawn("node", ["--import", "tsx", "src/main.ts"], {
			cwd: join(ROOT, "apps", "runner"),
			env: { PATH: process.env.PATH, PASS: pass, WORKER_URL: this.proxyUrl },
			stdio: "ignore",
		});
		return new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
	}

	async setUpAccount(): Promise<void> {
		await this.admin({
			type: "CreateAccount",
			commandId: ACCOUNT,
			at: AT,
			name: "Cafe A",
			timeZone: "Asia/Riyadh",
			language: "en",
			modelProfile: "test",
			initialCredits: 100,
		});
		await this.admin({
			type: "AddOwner",
			commandId: OWNER_COMMAND,
			at: AT,
			accountId: ACCOUNT,
			identityRef: "owner-a",
		});
	}

	async send(command: Record<string, unknown>): Promise<void> {
		const answer = await this.api("/v1/commands", "owner-a", { at: AT, ...command });
		if (!answer.ok) throw new Error(`The command failed: ${await answer.text()}`);
	}

	ownerMessage(commandId: string, text: string): Promise<void> {
		return this.send({ type: "OwnerMessage", commandId, messageId: `m-${commandId}`, channel: "chat", text });
	}
}
