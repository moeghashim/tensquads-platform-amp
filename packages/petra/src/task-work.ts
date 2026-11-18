// The work of Petra on tasks and attempts (docs/ARCHITECTURE.md, sections 3.6, 4.2, 4.6 and 9).
// Each step writes by a key from its cause. A step that runs again finds its rows and changes nothing.
// The Durable Object class gives the ports. This module has no Cloudflare import.
import { testBot } from "@tensquads/bots";
import type { BotDefinition, Brief, Command, PassClaims, TaskResult } from "@tensquads/contracts";
import type { Queue, Sandbox } from "@tensquads/core";

import type { Outbox, PetraStorage } from "./outbox.js";
import type { AttemptRow, TaskReader, TaskRow, TaskWriter } from "./task-writer.js";
import { answerRef } from "./task-writer.js";

// The times of section 10, in milliseconds.
export interface TaskSettings {
	attemptMaxMs: number;
	silentMs: number;
}

// A message in the "jobs" queue. The consumer gives the command to the Petra of the account.
export interface JobMessage {
	accountId: string;
	command: Command;
}

export interface TaskWorkDeps {
	accountId: string;
	tasks: TaskWriter & TaskReader;
	outbox: Outbox;
	storage: PetraStorage;
	sandbox: Sandbox;
	queue: Queue;
	signPass: (claims: PassClaims) => Promise<string>;
	// The time when a launcher took the sandbox request of the attempt, or undefined.
	takenAt: (taskId: string, attemptNo: number) => Promise<number | undefined>;
	// The credits double of task 04 always says true. Task 07 replaces it.
	creditsSufficient: (credits: number) => Promise<boolean>;
	settings: TaskSettings;
	now: () => string;
}

export interface NewTask {
	commandId: string;
	bot: string;
	taskType: string;
	goal: string;
	replyTo: string;
}

export type StartOutcome = "started" | "no credits" | "ended";
export type CancelOutcome = "cancelled" | "no task" | "ended";

export interface TaskWork {
	// The tool "start a task" (section 4.6). One command starts one task or none. The task id is the command id.
	startTask(task: NewTask): Promise<StartOutcome>;
	// The tool "stop a task" and the command CancelTask (requirement L15).
	cancel(taskId: string): Promise<CancelOutcome>;
	sandboxExited(command: Extract<Command, { type: "SandboxExited" }>): Promise<void>;
	checkTask(commandId: string, taskId: string): Promise<void>;
	ownerAnswer(command: Extract<Command, { type: "OwnerAnswer" }>): Promise<boolean>;
	// After a result that stands (section 4.2).
	afterResult(claims: PassClaims, result: TaskResult): Promise<void>;
	// Sends the request again for each open attempt that has no start (sections 3.6 and 7.3).
	resendRequests(): Promise<void>;
	// The gateway calls this for each call, so the check of the task knows the last call.
	noteCall(taskId: string, attemptNo: number): Promise<void>;
}

const BOTS: readonly BotDefinition[] = [testBot];
const ENDED = new Set(["done", "failed", "cancelled"]);
// Three attempts in sequence with no start make the task fail (section 3.6).
const NOT_STARTED_LIMIT = 3;

function taskTypeOf(bot: string, name: string) {
	const taskType = BOTS.find((item) => item.id === bot)?.taskTypes.find((item) => item.name === name);
	if (!taskType) throw new Error(`The bot "${bot}" has no task type "${name}".`);
	return taskType;
}

// One check of one attempt. "next" puts the next check in the queue.
interface AttemptCheck {
	task: TaskRow;
	commandId: string;
	attemptNo: number;
	next: () => Promise<void>;
}

// The brief has six parts (requirement L1). The memory adds facts in a later task.
function briefOf(task: NewTask): Brief {
	const { limits } = taskTypeOf(task.bot, task.taskType);
	return {
		goal: task.goal,
		done: "The owner has the answer.",
		facts: [],
		limits,
		notInTask: ["Actions that send something out."],
		replyTo: task.replyTo,
	};
}

// The id of a check job has the attempt and the number of the check. The task id is the target.
const CHECK_ID = /^check\/(\d+)\/(\d+)\//;
export const checkCommandId = (taskId: string, attemptNo: number, checkNo: number): string =>
	`check/${attemptNo}/${checkNo}/${taskId}`;
const lastCallKey = (taskId: string, attemptNo: number) => `petra_call/${taskId}/${attemptNo}`;

export function taskWork(deps: TaskWorkDeps): TaskWork {
	const { tasks, outbox, settings } = deps;
	const nowMs = () => Date.parse(deps.now());

	async function queueCheck(taskId: string, attemptNo: number, checkNo: number): Promise<void> {
		const command: Command = {
			type: "RunJob",
			commandId: checkCommandId(taskId, attemptNo, checkNo),
			at: deps.now(),
			job: "check task",
			targetId: taskId,
		};
		const message: JobMessage = { accountId: deps.accountId, command };
		await deps.queue.send("jobs", message, { delaySeconds: Math.ceil(settings.silentMs / 1000) });
	}

	// Step 4 of "start a task", and of each new attempt: the request for a sandbox and the "check task" job.
	// Only the current attempt gets a request, and only while it has no start.
	async function requestSandbox(task: TaskRow, attemptNo: number): Promise<void> {
		const current = await tasks.currentAttempt(task.id);
		if (current?.attemptNo !== attemptNo || current.startedAt !== null || current.exit !== null) return;
		const endsAt = nowMs() + settings.attemptMaxMs;
		const claims = { accountId: deps.accountId, bot: task.bot, taskId: task.id, attemptNo, endsAt };
		await deps.sandbox.start({
			accountId: deps.accountId,
			taskId: task.id,
			attemptNo,
			pass: await deps.signPass(claims),
		});
		await queueCheck(task.id, attemptNo, 1);
	}

	// A cause that made its attempt already: Petra stopped after that write. She does the missing steps.
	async function continueCause(task: TaskRow, causeRef: string): Promise<boolean> {
		const attempt = (await tasks.attempts(task.id)).find((item) => item.causeRef === causeRef);
		if (!attempt) return false;
		if (task.status === "waiting for the owner") {
			await tasks.setTaskStatus({ taskId: task.id, status: "running", at: deps.now() });
		}
		await requestSandbox(task, attempt.attemptNo);
		return true;
	}

	async function newAttempt(task: TaskRow, causeRef: string, reason: AttemptRow["reason"]): Promise<void> {
		const attemptNo = await tasks.addAttempt({ taskId: task.id, causeRef, reason, versions: {} });
		await requestSandbox(task, attemptNo);
	}

	async function fail(task: TaskRow): Promise<void> {
		await tasks.setTaskStatus({ taskId: task.id, status: "failed", stop: "error", at: deps.now() });
		await outbox.tell({
			sourceRef: `task/${task.id}/failed`,
			channel: task.brief.replyTo,
			taskId: task.id,
			body: { type: "reply", text: `The task ${task.id} stopped two times. It failed.` },
		});
	}

	// A sandbox that stopped (requirement L5). One new attempt for each task, then "failed".
	async function failure(task: TaskRow, causeRef: string): Promise<void> {
		const attempts = await tasks.attempts(task.id);
		if (attempts.some((item) => item.reason === "after a failure")) return fail(task);
		await newAttempt(task, causeRef, "after a failure");
	}

	// A launcher took the request and no start came. This is not a failure of the task (section 3.6).
	async function didNotStart(task: TaskRow, causeRef: string): Promise<void> {
		let inSequence = 0;
		for (const attempt of (await tasks.attempts(task.id)).reverse()) {
			if (attempt.reason !== "the sandbox did not start") break;
			inSequence += 1;
		}
		if (inSequence >= NOT_STARTED_LIMIT) return fail(task);
		await newAttempt(task, causeRef, "the sandbox did not start");
	}

	// The time of the last call of the attempt: the start, or a later call that this Petra saw.
	async function lastCall(attempt: AttemptRow & { startedAt: string }): Promise<number> {
		const noted = (await deps.storage.get<number>(lastCallKey(attempt.taskId, attempt.attemptNo))) ?? 0;
		return Math.max(Date.parse(attempt.startedAt), noted);
	}

	async function tellQuestion(task: TaskRow, question: NonNullable<TaskResult["question"]>): Promise<void> {
		await outbox.tell({
			sourceRef: `task/${task.id}/question/${question.id}`,
			channel: task.brief.replyTo,
			taskId: task.id,
			body: { type: "question", questionId: question.id, text: question.text, options: [] },
		});
	}

	async function openTask(taskId: string): Promise<TaskRow | undefined> {
		const task = await tasks.task(taskId);
		return task && !ENDED.has(task.status) ? task : undefined;
	}

	// A launcher took the request, and no start came in the silent time (section 3.6).
	async function checkNotStarted(check: AttemptCheck): Promise<void> {
		const { task, commandId, attemptNo } = check;
		const takenAt = await deps.takenAt(task.id, attemptNo);
		// No launcher took the request yet: it stays in the list (section 9).
		if (takenAt === undefined || nowMs() - takenAt < settings.silentMs) return check.next();
		await tasks.endAttempt({ taskId: task.id, attemptNo, exit: "did not start", at: deps.now() });
		return didNotStart(task, commandId);
	}

	// A sandbox with no gateway call in the silent time is handled as a sandbox that stopped.
	async function checkSilent(check: AttemptCheck, attempt: Parameters<typeof lastCall>[0]): Promise<void> {
		const { task, commandId, attemptNo } = check;
		if (nowMs() - (await lastCall(attempt)) < settings.silentMs) return check.next();
		await tasks.endAttempt({ taskId: task.id, attemptNo, exit: "silent", at: deps.now() });
		await failure(task, commandId);
	}

	return {
		async startTask(newTask) {
			const { price } = taskTypeOf(newTask.bot, newTask.taskType);
			const at = deps.now();
			// Step 1: the task row. A second run finds it.
			if (!(await tasks.task(newTask.commandId))) {
				if (!(await deps.creditsSufficient(price))) return "no credits";
				await tasks.createTask({ ...newTask, brief: briefOf(newTask), at });
			}
			const task = await openTask(newTask.commandId);
			if (!task) return "ended";
			// Step 2: the charge. Step 3: attempt 1, with the command id as its cause. Step 4: the request.
			await tasks.chargeTask({ taskId: task.id, credits: price, at });
			const attemptNo = await tasks.addAttempt({
				taskId: task.id,
				causeRef: newTask.commandId,
				reason: "first",
				versions: {},
			});
			await requestSandbox(task, attemptNo);
			return "started";
		},

		async cancel(taskId) {
			const task = await tasks.task(taskId);
			if (!task) return "no task";
			// A cancel that runs again continues. A task that ended in another way does not change.
			if (ENDED.has(task.status) && task.stop !== "cancelled") return "ended";
			const at = deps.now();
			const attempts = await tasks.attempts(taskId);
			await tasks.setTaskStatus({ taskId, status: "cancelled", stop: "cancelled", at });
			const current = attempts.at(-1);
			// The pass ends: each later call finds a task that ended, and is refused.
			if (current) await tasks.endAttempt({ taskId, attemptNo: current.attemptNo, exit: "cancelled", at });
			// The credits go back only if no runner made a start call (requirement T3).
			const giveBack = attempts.every((attempt) => attempt.startedAt === null);
			if (giveBack) await tasks.giveBack({ taskId, credits: taskTypeOf(task.bot, task.taskType).price, at });
			const turns = await tasks.countTrail(taskId, "model call");
			const credits = giveBack ? " The credits went back." : "";
			await outbox.tell({
				sourceRef: `task/${taskId}/cancelled`,
				channel: task.brief.replyTo,
				taskId,
				body: {
					type: "reply",
					text: `The task ${taskId} is stopped. Before the stop, it did ${turns} turns.${credits}`,
				},
			});
			return "cancelled";
		},

		async sandboxExited(command) {
			const task = await tasks.task(command.taskId);
			if (!task || (await continueCause(task, command.commandId))) return;
			// Petra uses a report only for the current attempt of a task that runs (section 3.6).
			// A runner that exits after a result or a park left the task "done" or "waiting for the owner".
			const current = await tasks.currentAttempt(task.id);
			if (task.status !== "running" || current?.attemptNo !== command.attempt) return;
			const at = deps.now();
			await tasks.endAttempt({ taskId: task.id, attemptNo: command.attempt, exit: `exit ${command.exitCode}`, at });
			await failure(task, command.commandId);
		},

		async checkTask(commandId, taskId) {
			const match = CHECK_ID.exec(commandId);
			const task = await openTask(taskId);
			if (!match || !task || task.status === "waiting for the owner") return;
			if (await continueCause(task, commandId)) return;
			const attemptNo = Number(match[1]);
			const current = await tasks.currentAttempt(taskId);
			// A check of an old attempt does nothing. The new attempt has its own checks.
			if (current?.attemptNo !== attemptNo) return;
			const check = { task, commandId, attemptNo, next: () => queueCheck(taskId, attemptNo, Number(match[2]) + 1) };
			if (current.startedAt === null) return checkNotStarted(check);
			return checkSilent(check, { ...current, startedAt: current.startedAt });
		},

		async ownerAnswer(command) {
			const taskId = await tasks.questionTask(command.questionId);
			const task = taskId ? await openTask(taskId) : undefined;
			if (!task) return false;
			if (await continueCause(task, command.commandId)) return true;
			if (task.status !== "waiting for the owner") return false;
			// The decision goes to the runner as a signal, with the question id as its key (requirement L6).
			await tasks.addDecision({
				sourceRef: answerRef(command.questionId),
				decider: "owner",
				taskId: task.id,
				point: "question",
				options: [],
				answer: command.text,
				at: command.at,
			});
			const attemptNo = await tasks.addAttempt({
				taskId: task.id,
				causeRef: command.commandId,
				reason: "after an answer",
				versions: {},
			});
			// The status is "running" before the request, so the pass of the new attempt is accepted.
			await tasks.setTaskStatus({ taskId: task.id, status: "running", at: deps.now() });
			await requestSandbox(task, attemptNo);
			return true;
		},

		async afterResult(claims, result) {
			const task = await tasks.task(claims.taskId);
			if (!task) return;
			const at = deps.now();
			const { taskId, attemptNo } = claims;
			if (result.stop === "success") {
				await tasks.endAttempt({ taskId, attemptNo, exit: "result", at });
				await outbox.tell({
					sourceRef: `task/${taskId}/result`,
					channel: task.brief.replyTo,
					taskId,
					body: { type: "result", taskId, summary: result.answer || "(no answer)", evidence: result.evidence },
				});
				await tasks.setTaskStatus({ taskId, status: "done", stop: "success", at });
			} else if (result.stop === "question" && result.question) {
				await tasks.endAttempt({ taskId, attemptNo, exit: "question", at });
				await tasks.setTaskStatus({ taskId, status: "waiting for the owner", stop: "question", at });
				await tellQuestion(task, result.question);
			} else if (result.stop === "max_turns" || result.stop === "max_budget") {
				await tasks.endAttempt({ taskId, attemptNo, exit: result.stop, at });
				await tasks.setTaskStatus({ taskId, status: "done", stop: result.stop, at });
				await tasks.giveBack({ taskId, credits: taskTypeOf(task.bot, task.taskType).price, at });
				await outbox.tell({
					sourceRef: `task/${taskId}/limit`,
					channel: task.brief.replyTo,
					taskId,
					body: {
						type: "reply",
						text: `The task ${taskId} stopped at the limit ${result.stop}. The credits went back.`,
					},
				});
			}
			// The stop "error" comes with an exit report. The report starts the new attempt.
		},

		async resendRequests() {
			for (const task of await tasks.openTasks()) {
				const current = await tasks.currentAttempt(task.id);
				if (current) await requestSandbox(task, current.attemptNo);
			}
		},

		async noteCall(taskId, attemptNo) {
			await deps.storage.put(lastCallKey(taskId, attemptNo), nowMs());
		},
	};
}
