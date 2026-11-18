// The parts of Petra for the Node tests of task 04, against a real Postgres.
// The sandbox list, the queue and the storage of the Durable Object are fakes in memory.
import type { OwnerMessage, PassClaims } from "@tensquads/contracts";
import type { Database, SandboxRequest } from "@tensquads/core";
import { signPass } from "@tensquads/gateway";
import {
	accountWriter,
	type JobMessage,
	outbox,
	type PetraStorage,
	petraTools,
	platformWriter,
	type TaskWork,
	taskWork,
	taskWriter,
} from "@tensquads/petra";

import { testDatabase, uniqueId } from "./db.js";

export const AT = "2026-11-18T10:00:00.000Z";
const PASS_KEY = "test-pass-key";
const SETTINGS = { attemptMaxMs: 1_800_000, silentMs: 120_000 };

export function memoryStorage(): PetraStorage & { map: Map<string, unknown> } {
	const map = new Map<string, unknown>();
	return {
		map,
		get: async <T>(key: string) => map.get(key) as T | undefined,
		put: async (key, value) => void map.set(key, structuredClone(value)),
	};
}

type Tasks = ReturnType<typeof taskWriter>;

export interface BuildOptions {
	storage?: PetraStorage;
	tasks?: Tasks;
	// Runs before the request goes to the list. A throw here stops Petra at step 4.
	beforeSandbox?: () => void;
	afterSandbox?: () => void;
}

export interface Harness {
	database: Database;
	accountId: string;
	writer: ReturnType<typeof accountWriter>;
	tasks: Tasks;
	storage: ReturnType<typeof memoryStorage>;
	// The list of the Platform object: one request for each task and attempt.
	list: Map<string, SandboxRequest>;
	jobs: { body: JobMessage; delaySeconds: number | undefined }[];
	sent: OwnerMessage[];
	taken: Map<string, number>;
	setNow(iso: string): void;
	now(): string;
	build(options?: BuildOptions): {
		work: TaskWork;
		out: ReturnType<typeof outbox>;
		tools: ReturnType<typeof petraTools>;
	};
	claims(taskId: string, attemptNo: number): PassClaims;
}

export async function harness(prefix: string): Promise<Harness> {
	const database = testDatabase();
	const accountId = uniqueId(prefix);
	await platformWriter(database).addAccount({
		id: accountId,
		name: prefix,
		timeZone: "UTC",
		language: "en",
		modelProfile: "test",
		at: AT,
	});
	const writer = accountWriter(database, accountId);
	const tasks = taskWriter(database, accountId);
	const storage = memoryStorage();
	const list = new Map<string, SandboxRequest>();
	const jobs: Harness["jobs"] = [];
	const sent: OwnerMessage[] = [];
	const taken = new Map<string, number>();
	let now = AT;
	const clock = () => now;
	return {
		database,
		accountId,
		writer,
		tasks,
		storage,
		list,
		jobs,
		sent,
		taken,
		setNow: (iso) => {
			now = iso;
		},
		now: clock,
		build(options = {}) {
			const store = options.storage ?? storage;
			const usedTasks = options.tasks ?? tasks;
			const out = outbox({ writer, storage: store, now: clock, send: (message) => void sent.push(message) });
			const work = taskWork({
				accountId,
				tasks: usedTasks,
				outbox: out,
				storage: store,
				sandbox: {
					start: async (request) => {
						options.beforeSandbox?.();
						const key = `${request.taskId}/${request.attemptNo}`;
						if (!list.has(key)) list.set(key, request);
						options.afterSandbox?.();
						return { sandboxId: key };
					},
				},
				queue: {
					send: async (_queue, body, sendOptions) => {
						jobs.push({ body: body as JobMessage, delaySeconds: sendOptions?.delaySeconds });
					},
				},
				signPass: (claims) => signPass(claims, PASS_KEY),
				takenAt: async (taskId, attemptNo) => taken.get(`${taskId}/${attemptNo}`),
				creditsSufficient: async () => true,
				settings: SETTINGS,
				now: clock,
			});
			const tools = petraTools({ writer, tasks: usedTasks, work, outbox: out, now: clock });
			return { work, out, tools };
		},
		claims: (taskId, attemptNo) => ({
			accountId,
			bot: "test-bot",
			taskId,
			attemptNo,
			endsAt: Date.parse(now) + SETTINGS.attemptMaxMs,
		}),
	};
}

// Runs one tool of Petra, as the loop runs it.
export async function runTool(tools: ReturnType<typeof petraTools>, name: string, input: Record<string, unknown>) {
	const tool = tools.find((item) => item.name === name);
	if (!tool) throw new Error(`No tool "${name}".`);
	return tool.execute({ channel: "chat", ...input });
}

// The rows that "start a task" writes, for one account.
export async function taskRows(database: Database, accountId: string) {
	return database.transaction({ role: "petra", accountId }, async (tx) => ({
		tasks: await tx.query<{ id: string; status: string; stop: string | null }>(
			"SELECT id, status, stop FROM tasks ORDER BY id",
		),
		ledger: await tx.query<{ source_ref: string; kind: string; credits: string }>(
			"SELECT source_ref, kind, credits FROM ledger ORDER BY source_ref",
		),
		attempts: await tx.query<{
			task_id: string;
			attempt_no: number;
			cause_ref: string;
			reason: string;
			exit: string | null;
		}>("SELECT task_id, attempt_no, cause_ref, reason, exit FROM attempts ORDER BY task_id, attempt_no"),
	}));
}

// The runner of an attempt made its start call, and the task runs.
export async function startRunner(h: Harness, taskId: string, attemptNo: number): Promise<void> {
	await h.tasks.bindRunner({ taskId, attemptNo, runnerId: `runner-${attemptNo}`, at: h.now() });
	await h.tasks.setTaskStatus({ taskId, status: "running", at: h.now() });
}
