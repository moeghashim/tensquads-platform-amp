// The gateway calls of one Petra (docs/ARCHITECTURE.md, sections 3.4, 3.5 and 4.3).
// The Worker checks the pass and parses the call. This module does the checks of Petra and the work of each call.
// The Durable Object class gives the storage, the task writer, the object store and the model. No Cloudflare import.
import { testBot } from "@tensquads/bots";
import {
	type ActionAnswer,
	type AttemptVersions,
	type BotDefinition,
	type Brief,
	type DraftFile,
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
import type { CallUsage, Model, ModelAnswer, ObjectStore } from "@tensquads/core";

// The part of the task writer of Petra that the gateway uses. The writer of packages/petra has this shape.
export interface GatewayTasks {
	task(taskId: string): Promise<{ bot: string; taskType: string; brief: Brief; status: string } | undefined>;
	currentAttempt(taskId: string): Promise<{ attemptNo: number; runnerId: string | null } | undefined>;
	bindRunner(bind: { taskId: string; attemptNo: number; runnerId: string; at: string }): Promise<string>;
	recordVersions(taskId: string, attemptNo: number, versions: Partial<AttemptVersions>): Promise<void>;
	setTaskStatus(change: { taskId: string; status: "running" | "done"; stop?: StopName; at: string }): Promise<void>;
	newestJournalCopy(taskId: string): Promise<{ attemptNo: number; callNo: number; blobKey: string } | undefined>;
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

// The gate (packages/gate). The gateway gives it each "action" call. This package does not import the gate (C2).
export interface GatewayGate {
	action(request: {
		taskId: string;
		attemptNo: number;
		// The number of the gateway call. The trail row of a refusal has it in its key (section 7.1).
		callNo: number;
		bot: string;
		toolCallId: string;
		tool: string;
		content: Record<string, unknown>;
	}): Promise<ActionAnswer | { busy: true }>;
}

// The part of the action writer of Petra that the gateway uses: the approval signals and the draft store.
export interface GatewayActions {
	// Each decided approval, with the tool-call id as its key (section 4.4).
	approvalSignals(taskId: string): Promise<SignalDelivery[]>;
	addDraftFile(draft: {
		taskId: string;
		path: string;
		attemptNo: number;
		callNo: number;
		blobKey: string;
		at: string;
	}): Promise<void>;
	// For each path, the newest file that is not newer than the copy.
	draftFiles(
		taskId: string,
		copy: { attemptNo: number; callNo: number },
	): Promise<{ path: string; blobKey: string }[]>;
}

// The costs (packages/costs). This package does not import them (C2). Each row has its attempt and its key.
export interface GatewayCosts {
	modelCall(ref: { taskId: string; attemptNo: number; callNo: number }, answer: ModelAnswer): Promise<void>;
	usage(
		ref: { taskId: string; attemptNo: number; callNo: number },
		kind: "checker model",
		usage: readonly CallUsage[],
	): Promise<void>;
	// The milliseconds since the previous gateway call of the attempt.
	sandbox(ref: { taskId: string; attemptNo: number; callNo: number }, ms: number): Promise<void>;
	// True when the cost rows of the task, over all its attempts, are at the budget or above it (requirement S9).
	overBudget(taskId: string, maxBudget: number): Promise<boolean>;
}

// The storage of the Durable Object. The keys of the gateway start with "petra_gw/" (section 7.3).
export interface GatewayStorage {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
}

// The check of a result: the tests by code of the bot, then the checker model (requirement K1).
export type ResultChecker = (input: {
	taskId: string;
	bot: string;
	brief: Brief;
	result: TaskResult;
	// The full forget list of the task. The check tests that the result does not use a forgotten fact (D11).
	forget: readonly string[];
}) => Promise<ResultAnswer & { usage?: readonly CallUsage[] }>;

export interface GatewayDeps {
	// The account of this Petra. A pass of another account is refused.
	accountId: string;
	tasks: GatewayTasks;
	actions: GatewayActions;
	gate: GatewayGate;
	objectStore: Pick<ObjectStore, "put" | "get">;
	model: Model;
	check: ResultChecker;
	costs: GatewayCosts;
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
	| ActionAnswer
	| { ok: true }
	| GatewayRefusal
	| { busy: true };

// A refusal and "busy" are not saved. The runner exits after a refusal, and tries again after "busy".
const isSaved = (answer: GatewayAnswer) => !("refused" in answer) && !("busy" in answer);

export interface Gateway {
	// The claims come from a pass that the Worker verified. The call is parsed with the schema gatewayCall.
	call(claims: PassClaims, call: GatewayCall): Promise<GatewayAnswer>;
}

// The bot definitions come from the same package as the runner reads (requirement L13).
const BOTS: readonly BotDefinition[] = [testBot];

// A task that waits for the owner still takes the calls of its current attempt: after the answer "wait",
// the runner saves the journal and gives its result (section 4.4).
const OPEN_STATUSES = new Set(["starting", "running", "waiting for the owner"]);
const OK = { ok: true } as const;

type OpenTask = { bot: string; taskType: string; brief: Brief };

function limitsOf(task: OpenTask): { maxTurns: number; maxBudget: number } {
	const bot = BOTS.find((item) => item.id === task.bot);
	const taskType = bot?.taskTypes.find((item) => item.name === task.taskType);
	if (!taskType) throw new Error(`The bot "${task.bot}" has no task type "${task.taskType}".`);
	return taskType.limits;
}

function botVersion(task: OpenTask): string {
	const bot = BOTS.find((item) => item.id === task.bot);
	if (!bot) throw new Error(`No definition for the bot "${task.bot}".`);
	return bot.version;
}

// The source reference of a trail row from one gateway call (section 7.1). The kind has hyphens for spaces.
// The time of the last admitted call of the attempt, in the storage of Petra.
const lastCallKey = (claims: PassClaims) => `petra_gw_at/${claims.taskId}/${claims.attemptNo}`;

const trailRef = (claims: PassClaims, callNo: number, kind: string): string =>
	`task/${claims.taskId}/${claims.attemptNo}/${callNo}/${kind.replaceAll(" ", "-")}`;

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
		const journal = copy ? await stored(copy.blobKey) : null;
		// A first attempt has no copy, so it has no draft files (requirement G11).
		const drafts = copy ? await draftsOf(taskId, copy) : [];
		const signals = await signalsOf(taskId);
		return startAnswer.parse({ brief: task.brief, taskType: task.taskType, forget, journal, signals, drafts });
	}

	async function stored(blobKey: string): Promise<string> {
		const body = await deps.objectStore.get(blobKey);
		if (body === undefined) throw new Error(`The object "${blobKey}" is not in the object store.`);
		return body;
	}

	async function draftsOf(taskId: string, copy: { attemptNo: number; callNo: number }): Promise<DraftFile[]> {
		const files = await deps.actions.draftFiles(taskId, copy);
		return Promise.all(files.map(async (file) => ({ path: file.path, body: await stored(file.blobKey) })));
	}

	// The answers of the owner to questions, and the decisions of the owner on approvals (section 4.4).
	async function signalsOf(taskId: string): Promise<SignalDelivery[]> {
		return [...(await tasks.signals(taskId)), ...(await deps.actions.approvalSignals(taskId))];
	}

	// A changed file goes to the draft store, with the attempt and the call number of the save (requirement G11).
	async function draft(claims: PassClaims, call: Extract<GatewayCall, { call: "draft" }>) {
		const { taskId, attemptNo } = claims;
		const blobKey = `draft/${taskId}/${attemptNo}/${call.callNo}/${call.path}`;
		await deps.objectStore.put(blobKey, call.body);
		await deps.actions.addDraftFile({
			taskId,
			path: call.path,
			attemptNo,
			callNo: call.callNo,
			blobKey,
			at: deps.now(),
		});
		return OK;
	}

	async function model(task: OpenTask, claims: PassClaims, call: Extract<GatewayCall, { call: "model" }>) {
		const { taskId, attemptNo } = claims;
		const sourceRef = trailRef(claims, call.callNo, "model call");
		// Petra stopped after the trail row and before she saved the answer. The row has the answer.
		const earlier = await tasks.trailRow(sourceRef);
		if (earlier) return (earlier.data as { answer: ModelAnswer }).answer;
		// The limits count the model calls and the cost rows of all attempts of the task (requirements L4, L5, S9).
		const limits = limitsOf(task);
		if ((await tasks.countTrail(taskId, "model call")) >= limits.maxTurns) return { limit: "max_turns" } as const;
		if (await deps.costs.overBudget(taskId, limits.maxBudget)) return { limit: "max_budget" } as const;
		const answer = await deps.model.complete({ messages: call.messages, tools: call.tools });
		await tasks.recordVersions(taskId, attemptNo, { provider: answer.provider, model: answer.model });
		// The cost rows come before the trail row. If Petra stops between them, the call runs again: a real cost.
		await deps.costs.modelCall({ taskId, attemptNo, callNo: call.callNo }, answer);
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
		// Only an answer of the bot goes to the check (section 4.2). Petra reads each other stop by its name.
		const forget = call.result.stop === "success" ? (await tasks.inbox(taskId)).forget : [];
		const checked =
			call.result.stop === "success"
				? await deps.check({ taskId, bot: task.bot, brief: task.brief, result: call.result, forget })
				: { verdict: "stands" as const, reason: `A result with the stop ${call.result.stop} has no check.` };
		const { usage, ...verdict } = checked;
		if (usage) await deps.costs.usage({ taskId, attemptNo, callNo: call.callNo }, "checker model", usage);
		const at = deps.now();
		await tasks.addTrail({
			sourceRef: trailRef(claims, call.callNo, "check"),
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

	// The milliseconds since the previous gateway call of the attempt, by the clock of Petra (requirement S1).
	// The runner does not give a time. Each admitted call notes its time.
	const sandboxMs = (previous: number | undefined): number =>
		previous === undefined ? 0 : Math.max(0, Date.parse(deps.now()) - previous);

	async function work(
		task: OpenTask,
		claims: PassClaims,
		call: GatewayCall,
		previous?: number,
	): Promise<GatewayAnswer> {
		const { taskId, attemptNo } = claims;
		switch (call.call) {
			case "start":
				return start(task, claims, call);
			case "model":
				return model(task, claims, call);
			case "step":
				await deps.costs.sandbox({ taskId, attemptNo, callNo: call.callNo }, sandboxMs(previous));
				await tasks.addTrail({
					sourceRef: trailRef(claims, call.callNo, "tool use"),
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
				return { messages, forget, signals: await signalsOf(taskId) };
			}
			case "journal": {
				const blobKey = `journal/${taskId}/${attemptNo}/${call.callNo}`;
				await deps.objectStore.put(blobKey, call.copy);
				await tasks.addJournalCopy({ taskId, attemptNo, callNo: call.callNo, blobKey, at: deps.now() });
				return OK;
			}
			case "result":
				return result(task, claims, call);
			case "action": {
				const { callNo, toolCallId, tool, content } = call;
				return deps.gate.action({ taskId, attemptNo, callNo, bot: task.bot, toolCallId, tool, content });
			}
			case "draft":
				return draft(claims, call);
		}
	}

	return {
		async call(claims, call) {
			const admitted = await admit(claims, call);
			if ("refused" in admitted) return admitted;
			await deps.noteCall(claims);
			const previousCall = await deps.storage.get<number>(lastCallKey(claims));
			await deps.storage.put(lastCallKey(claims), Date.parse(deps.now()));
			const key = `petra_gw/${claims.taskId}/${claims.attemptNo}/${call.callNo}`;
			if (inProgress.has(key)) return { busy: true };
			inProgress.add(key);
			try {
				const saved = await deps.storage.get<GatewayAnswer>(key);
				if (saved !== undefined) return saved;
				const answer = await work(admitted, claims, call, previousCall);
				if (isSaved(answer)) await deps.storage.put(key, answer);
				return answer;
			} finally {
				inProgress.delete(key);
			}
		},
	};
}
