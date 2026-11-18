// The gateway calls of one Petra (docs/ARCHITECTURE.md, sections 3.4, 3.5 and 4.3).
// The Worker checks the pass and parses the call. This module does the checks of Petra and the work of each call.
// The Durable Object class gives the storage, the task writer, the object store and the model. No Cloudflare import.
import { testBot } from "@tensquads/bots";
import {
	type AttemptVersions,
	type BotDefinition,
	type Brief,
	type GatewayCall,
	type InboxAnswer,
	type InboxMessage,
	type PassClaims,
	type ResultAnswer,
	type SignalDelivery,
	type StartAnswer,
	type StopName,
	startAnswer,
	type TaskResult,
} from "@tensquads/contracts";
import type { Model, ModelAnswer, ObjectStore } from "@tensquads/core";

// The part of the task writer of Petra that the gateway uses. The writer of packages/petra has this shape.
export interface GatewayTasks {
	task(taskId: string): Promise<{ bot: string; taskType: string; brief: Brief; status: string } | undefined>;
	currentAttempt(taskId: string): Promise<{ attemptNo: number; runnerId: string | null } | undefined>;
	bindRunner(bind: { taskId: string; attemptNo: number; runnerId: string; at: string }): Promise<string>;
	recordVersions(taskId: string, attemptNo: number, versions: Partial<AttemptVersions>): Promise<void>;
	setTaskStatus(change: { taskId: string; status: "running" | "done"; stop?: StopName; at: string }): Promise<void>;
	newestJournalCopy(taskId: string): Promise<{ blobKey: string } | undefined>;
	addJournalCopy(copy: {
		taskId: string;
		attemptNo: number;
		callNo: number;
		blobKey: string;
		at: string;
	}): Promise<void>;
	inbox(taskId: string): Promise<{ messages: InboxMessage[]; forget: string[] }>;
	addTrail(row: {
		sourceRef: string;
		taskId: string;
		attemptNo: number;
		turnNo: number | null;
		kind: "model call" | "tool use" | "check";
		actor: string;
		summary: string;
		data?: unknown;
		at: string;
	}): Promise<void>;
	trailRow(sourceRef: string): Promise<{ data: unknown } | undefined>;
	countTrail(taskId: string, kind: "model call"): Promise<number>;
	// The decisions of the owner that the runner delivers as signals (section 4.4, requirement L6).
	signals(taskId: string): Promise<SignalDelivery[]>;
}

// The storage of the Durable Object. The keys of the gateway start with "petra_gw/" (section 7.3).
export interface GatewayStorage {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
}

// The check of a result. In task 04 the double always says "stands" (task 06 replaces it).
export type ResultChecker = (input: { taskId: string; brief: Brief; result: TaskResult }) => Promise<ResultAnswer>;

export interface GatewayDeps {
	// The account of this Petra. A pass of another account is refused.
	accountId: string;
	tasks: GatewayTasks;
	objectStore: Pick<ObjectStore, "put" | "get">;
	model: Model;
	check: ResultChecker;
	storage: GatewayStorage;
	now: () => string;
	// The commit of the Worker, for the versions of the attempt (requirement L11).
	workerCommit: string;
	// Petra handles a result that stands: she ends the attempt, tells the owner and ends or parks the task (section 4.2).
	settle: (claims: PassClaims, result: TaskResult) => Promise<void>;
	// Petra notes the time of each admitted call, for the silent time of the "check task" job (section 10).
	noteCall: (claims: PassClaims) => Promise<void>;
}

export type GatewayRefusal = { refused: "pass" | "runner" | "attempt" | "task" };

export type GatewayAnswer =
	| StartAnswer
	| ModelAnswer
	| { limit: "max_turns" | "max_budget" }
	| InboxAnswer
	| ResultAnswer
	| { ok: true }
	| GatewayRefusal
	| { busy: true };

export interface Gateway {
	// The claims come from a pass that the Worker verified. The call is parsed with the schema gatewayCall.
	call(claims: PassClaims, call: GatewayCall): Promise<GatewayAnswer>;
}

// The bot definitions come from the same package as the runner reads (requirement L13).
const BOTS: readonly BotDefinition[] = [testBot];

const OPEN_STATUSES = new Set(["starting", "running"]);
const OK = { ok: true } as const;

type OpenTask = { bot: string; taskType: string; brief: Brief };

function maxTurns(task: OpenTask): number {
	const bot = BOTS.find((item) => item.id === task.bot);
	const taskType = bot?.taskTypes.find((item) => item.name === task.taskType);
	if (!taskType) throw new Error(`The bot "${task.bot}" has no task type "${task.taskType}".`);
	return taskType.limits.maxTurns;
}

function botVersion(task: OpenTask): string {
	const bot = BOTS.find((item) => item.id === task.bot);
	if (!bot) throw new Error(`No definition for the bot "${task.bot}".`);
	return bot.version;
}

export function gateway(deps: GatewayDeps): Gateway {
	const { tasks } = deps;
	// The marks "in progress" are in memory only. They go away if Petra stops (section 3.5).
	const inProgress = new Set<string>();

	type StoredTask = Awaited<ReturnType<GatewayTasks["task"]>>;

	function isOpenFor(task: StoredTask, claims: PassClaims): task is NonNullable<StoredTask> {
		return task !== undefined && OPEN_STATUSES.has(task.status) && task.bot === claims.bot;
	}

	// A start can bind a runner id. Each other call must have the runner id that start bound.
	function runnerFits(bound: string | null, call: GatewayCall): boolean {
		return bound === call.runnerId || (call.call === "start" && bound === null);
	}

	// The checks of Petra (section 3.4). The runner id is checked before the saved answer.
	async function admit(claims: PassClaims, call: GatewayCall): Promise<OpenTask | GatewayRefusal> {
		if (claims.accountId !== deps.accountId) return { refused: "task" };
		const task = await tasks.task(claims.taskId);
		if (!isOpenFor(task, claims)) return { refused: "task" };
		const attempt = await tasks.currentAttempt(claims.taskId);
		if (attempt?.attemptNo !== claims.attemptNo) return { refused: "attempt" };
		return runnerFits(attempt.runnerId, call) ? task : { refused: "runner" };
	}

	async function start(task: OpenTask, claims: PassClaims, call: Extract<GatewayCall, { call: "start" }>) {
		const { taskId, attemptNo } = claims;
		const at = deps.now();
		// The first runner id wins, also when two starts come at the same time.
		const bound = await tasks.bindRunner({ taskId, attemptNo, runnerId: call.runnerId, at });
		if (bound !== call.runnerId) return { refused: "runner" } as const;
		await tasks.recordVersions(taskId, attemptNo, {
			workerCommit: deps.workerCommit,
			runnerCommit: call.runnerCommit,
			pluginListHash: call.pluginListHash,
			botVersion: botVersion(task),
		});
		await tasks.setTaskStatus({ taskId, status: "running", at });
		const { forget } = await tasks.inbox(taskId);
		const copy = await tasks.newestJournalCopy(taskId);
		let journal: string | null = null;
		if (copy) {
			const body = await deps.objectStore.get(copy.blobKey);
			if (body === undefined) throw new Error(`The journal copy "${copy.blobKey}" is not in the object store.`);
			journal = body;
		}
		const signals = await tasks.signals(taskId);
		return startAnswer.parse({ brief: task.brief, taskType: task.taskType, forget, journal, signals });
	}

	async function model(task: OpenTask, claims: PassClaims, call: Extract<GatewayCall, { call: "model" }>) {
		const { taskId, attemptNo } = claims;
		const sourceRef = `gw/${taskId}/${attemptNo}/${call.callNo}`;
		// Petra stopped after the trail row and before she saved the answer. The row has the answer.
		const earlier = await tasks.trailRow(sourceRef);
		if (earlier) return (earlier.data as { answer: ModelAnswer }).answer;
		// The limit counts the model calls of all attempts of the task (requirements L4, L5).
		if ((await tasks.countTrail(taskId, "model call")) >= maxTurns(task)) return { limit: "max_turns" } as const;
		// Task 10 adds the limit of budget.
		const answer = await deps.model.complete({ messages: call.messages, tools: call.tools });
		await tasks.recordVersions(taskId, attemptNo, { provider: answer.provider, model: answer.model });
		await tasks.addTrail({
			sourceRef,
			taskId,
			attemptNo,
			turnNo: call.turnNo,
			kind: "model call",
			actor: task.bot,
			summary: `The model answered in turn ${call.turnNo}.`,
			data: { answer },
			at: deps.now(),
		});
		return answer;
	}

	async function result(task: OpenTask, claims: PassClaims, call: Extract<GatewayCall, { call: "result" }>) {
		const { taskId, attemptNo } = claims;
		const verdict = await deps.check({ taskId, brief: task.brief, result: call.result });
		const at = deps.now();
		await tasks.addTrail({
			sourceRef: `gw/${taskId}/${attemptNo}/${call.callNo}`,
			taskId,
			attemptNo,
			turnNo: null,
			kind: "check",
			actor: task.bot,
			summary: `The result ${verdict.verdict === "stands" ? "stands" : "does not stand"}: ${verdict.reason}`,
			data: { verdict: verdict.verdict, stop: call.result.stop },
			at,
		});
		if (verdict.verdict === "stands") await deps.settle(claims, call.result);
		return verdict;
	}

	async function work(task: OpenTask, claims: PassClaims, call: GatewayCall): Promise<GatewayAnswer> {
		const { taskId, attemptNo } = claims;
		switch (call.call) {
			case "start":
				return start(task, claims, call);
			case "model":
				return model(task, claims, call);
			case "step":
				await tasks.addTrail({
					sourceRef: `gw/${taskId}/${attemptNo}/${call.callNo}`,
					taskId,
					attemptNo,
					turnNo: call.turnNo,
					kind: "tool use",
					actor: task.bot,
					summary: call.summary,
					data: { toolCallId: call.toolCallId, tool: call.tool },
					at: deps.now(),
				});
				return OK;
			case "inbox": {
				const { messages, forget } = await tasks.inbox(taskId);
				return { messages, forget, signals: await tasks.signals(taskId) };
			}
			case "journal": {
				const blobKey = `journal/${taskId}/${attemptNo}/${call.callNo}`;
				await deps.objectStore.put(blobKey, call.copy);
				await tasks.addJournalCopy({ taskId, attemptNo, callNo: call.callNo, blobKey, at: deps.now() });
				return OK;
			}
			case "result":
				return result(task, claims, call);
		}
	}

	return {
		async call(claims, call) {
			const admitted = await admit(claims, call);
			if ("refused" in admitted) return admitted;
			await deps.noteCall(claims);
			const key = `petra_gw/${claims.taskId}/${claims.attemptNo}/${call.callNo}`;
			if (inProgress.has(key)) return { busy: true };
			inProgress.add(key);
			try {
				const saved = await deps.storage.get<GatewayAnswer>(key);
				if (saved !== undefined) return saved;
				const answer = await work(admitted, claims, call);
				// A refusal is not saved. The runner exits after it.
				if (!("refused" in answer)) await deps.storage.put(key, answer);
				return answer;
			} finally {
				inProgress.delete(key);
			}
		},
	};
}
