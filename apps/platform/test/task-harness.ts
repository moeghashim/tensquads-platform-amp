// The parts of Petra for the Node tests of task 04, against a real Postgres.
// The sandbox list, the queue, the object store and the storage of the Durable Object are fakes in memory.
// The credits and the trail are the real packages, joined as the Durable Object joins them.
import { ruleModel } from "@tensquads/adapters-test";
import type { OwnerMessage, PassClaims } from "@tensquads/contracts";
import { type Database, ports, type SandboxRequest, startSystem } from "@tensquads/core";
import { credits } from "@tensquads/credits";
import { type Gateway, type GatewayGate, gateway, type ResultChecker, signPass } from "@tensquads/gateway";
import { cleanedFact, type Memory, memory as makeMemory } from "@tensquads/memory";
import {
	type ActionWriter,
	accountWriter,
	actionWriter,
	type Conversation,
	type JobMessage,
	memoryWriter,
	type NightJob,
	nightJob,
	nightWriter,
	outbox,
	type Petra,
	type PetraStorage,
	petra,
	petraTools,
	platformWriter,
	type TaskWork,
	taskWork,
	taskWriter,
} from "@tensquads/petra";
import { trail } from "@tensquads/trail";

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

// An object store in memory, with delete.
function memoryObjects() {
	const map = new Map<string, string>();
	return {
		map,
		put: async (key: string, body: string) => void map.set(key, body),
		get: async (key: string) => map.get(key),
		delete: async (key: string) => void map.delete(key),
	};
}

// The trail package on the task writer, as the Durable Object joins them.
const trailOf = (tasks: Tasks, objects: ReturnType<typeof memoryObjects>) =>
	trail({ store: tasks, objectStore: objects });

// The credits of a new account in the harness. A test with 0 gets no grant row.
const HARNESS_CREDITS = 100;

export interface BuildOptions {
	storage?: PetraStorage;
	tasks?: Tasks;
	// Runs before the request goes to the list. A throw here stops Petra at step 4.
	beforeSandbox?: () => void;
	afterSandbox?: () => void;
	// The "check action" job of the gate. The default does nothing.
	checkAction?: (commandId: string, actionId: string) => Promise<void>;
	// The conversation of Petra. The default has none.
	conversation?: Conversation;
}

export interface Harness {
	database: Database;
	accountId: string;
	writer: ReturnType<typeof accountWriter>;
	tasks: Tasks;
	// The trail package with the task writer and the object store of the harness.
	trail: ReturnType<typeof trailOf>;
	objects: ReturnType<typeof memoryObjects>;
	actions: ActionWriter;
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
		memory: Memory;
		// Petra with the rule model and the night job, as the Durable Object joins them (section 10.1).
		core: Petra;
		night: NightJob;
	};
	claims(taskId: string, attemptNo: number): PassClaims;
}

export async function harness(prefix: string, initialCredits = HARNESS_CREDITS, timeZone = "UTC"): Promise<Harness> {
	const database = testDatabase();
	const accountId = uniqueId(prefix);
	const model = (await startSystem([ruleModel()])).port(ports.model);
	await platformWriter(database).addAccount({
		id: accountId,
		name: prefix,
		timeZone,
		language: "en",
		modelProfile: "test",
		at: AT,
	});
	const writer = accountWriter(database, accountId);
	if (initialCredits > 0) await writer.addGrant({ sourceRef: "cmd/harness/grant", credits: initialCredits, at: AT });
	const rawTasks = taskWriter(database, accountId);
	const objects = memoryObjects();
	const book = trailOf(rawTasks, objects);
	const tasks: Tasks = { ...rawTasks, addTrail: book.add, trailRow: book.row };
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
		trail: book,
		objects,
		actions: actionWriter(database, accountId),
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
			const send = (message: OwnerMessage) => void sent.push(message);
			const out = outbox({ writer, storage: store, now: clock, send, addTrail: usedTasks.addTrail });
			const memory = makeMemory({
				store: memoryWriter(database, accountId),
				tasks: usedTasks,
				tell: out.tell,
				model,
			});
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
				credits: credits({
					store: { balance: writer.balance, chargeTask: usedTasks.chargeTask, giveBack: usedTasks.giveBack },
				}),
				settings: SETTINGS,
				now: clock,
				actions: actionWriter(database, accountId),
				checkAction: options.checkAction ?? (async () => undefined),
				memory,
			});
			const tools = petraTools({ writer, tasks: usedTasks, work, outbox: out, now: clock, memory });
			const night = nightJob({
				writer: nightWriter(database, accountId),
				memory,
				cancel: work.cancel,
				objectStore: objects,
				storage: store,
				clean: cleanedFact,
				trail: book.night,
				now: clock,
			});
			const core = petra({
				writer,
				storage: store,
				model,
				now: clock,
				send,
				outbox: out,
				work,
				memory,
				nightJob: night.run,
				...(options.conversation ? { conversation: options.conversation } : {}),
			});
			return { work, out, tools, memory, core, night };
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

// The gateway of the harness. The model always answers "ok", and the default check always says "stands".
// A result that stands goes to the task work. The default gate refuses each action.
export function harnessGateway(h: Harness, work: TaskWork, gate?: GatewayGate, check?: ResultChecker): Gateway {
	return gateway({
		accountId: h.accountId,
		tasks: h.tasks,
		actions: h.actions,
		gate: gate ?? { action: async () => ({ status: "refused", reason: "This test has no gate." }) },
		objectStore: h.objects,
		model: {
			complete: async () => ({
				text: "ok",
				toolCalls: [],
				provider: "test",
				model: "scripted",
				usage: { inputTokens: 1, outputTokens: 1 },
			}),
		},
		check: check ?? (async () => ({ verdict: "stands", reason: "The double always says stands." })),
		storage: memoryStorage(),
		now: h.now,
		workerCommit: "worker-abc",
		settle: (claims, result) => work.afterResult(claims, result),
		noteCall: async () => undefined,
	});
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
		// The ledger rows of the tasks. The grant of the harness has no task.
		ledger: await tx.query<{ source_ref: string; kind: string; credits: string }>(
			"SELECT source_ref, kind, credits FROM ledger WHERE task_id IS NOT NULL ORDER BY source_ref",
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
