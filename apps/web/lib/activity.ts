// The lines of the activity panel: what the page sent, what Petra wrote, and the state of each task.
import type { WorkerMessage } from "./owner-messages";

export interface ActivityLine {
	id: number;
	at: string;
	// The internal steps of Petra have the kind of the step (petra-steps.ts).
	kind: "send" | "recv" | "task" | "info" | "error" | "model" | "tool" | "decision" | "cost";
	text: string;
}

// The state of a task from GET /v1/tasks/{id}.
export interface TaskState {
	taskId: string;
	status: string;
	activity?: { bot?: string; attemptNo?: number; turnNo?: number | null; toolCall?: string | null };
}

const TASK_ENDED: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);

// "I started the task X." and "بدأت المهمة X." name the task in the text of a reply.
const STARTED = /(?:task|المهمة) ([A-Za-z0-9][\w-]*[A-Za-z0-9])/;

// The task ids that the messages name.
export function taskIdsOf(messages: readonly WorkerMessage[]): string[] {
	const ids = new Set<string>();
	for (const message of messages) {
		const found = typeof message.text === "string" ? STARTED.exec(message.text)?.[1] : undefined;
		const id = typeof message.taskId === "string" ? message.taskId : found;
		if (id) ids.add(id);
	}
	return [...ids];
}

const DETAIL: Record<string, (message: WorkerMessage) => string> = {
	approval_request: (m) => `${m.action} amount=${m.amount ?? "-"} limit=${m.limit ?? "-"} task=${m.taskId}`,
	approval_decided: (m) => `${m.decision}`,
	question: (m) => `id=${m.questionId}`,
	result: (m) => `task=${m.taskId}`,
	status: (m) => `task=${m.taskId} ${m.step}`,
};

// One line for a message of Petra. waitMs is the time since the last command of the page.
export function messageLine(message: WorkerMessage, waitMs: number | null): string {
	const detail = DETAIL[message.type]?.(message) ?? "";
	const wait = waitMs === null ? "" : ` (+${(waitMs / 1000).toFixed(1)} s)`;
	return `petra → ${message.type} #${message.seq}${detail ? ` ${detail}` : ""}${wait}`;
}

// One line for the state of a task. It has no times, so it changes only when the state changes.
export function taskLine(task: TaskState): string {
	const a = task.activity;
	const parts = [`task ${task.taskId}: ${task.status}`];
	if (a?.bot) parts.push(`${a.bot} attempt ${a.attemptNo ?? "-"} turn ${a.turnNo ?? "-"}`);
	if (a?.toolCall) parts.push(`tool ${a.toolCall}`);
	return parts.join(" · ");
}

type LineText = Pick<ActivityLine, "kind" | "text">;

// The lines for new messages of Petra. The first read of a session gives one summary line, not the history.
export function arrivalLines(fresh: readonly WorkerMessage[], first: boolean, waitMs: number | null): LineText[] {
	if (first) return [{ kind: "info", text: `signed in · ${fresh.length} earlier messages` }];
	return fresh.map((message) => ({ kind: "recv", text: messageLine(message, waitMs) }));
}

// The watch list: the last line of each task, or null for an ended task, which is not read again.
export type TaskWatch = Map<string, string | null>;

// Adds the tasks that new messages name to the watch list.
export function watchTasks(watched: TaskWatch, fresh: readonly WorkerMessage[]): void {
	for (const taskId of taskIdsOf(fresh)) {
		if (!watched.has(taskId)) watched.set(taskId, "");
	}
}

// The tasks to read now: each watched task that has not ended.
export const openWatched = (watched: TaskWatch): string[] =>
	[...watched].filter(([, line]) => line !== null).map(([taskId]) => taskId);

// Records the state of one watched task. Returns a line when the state changed.
export function taskUpdate(watched: TaskWatch, task: TaskState | undefined): string | undefined {
	if (!task) return undefined;
	const line = taskLine(task);
	const changed = watched.get(task.taskId) !== line;
	watched.set(task.taskId, TASK_ENDED.has(task.status) ? null : line);
	return changed ? line : undefined;
}

// The line for the answer of the Worker to a command.
export function sendResultLine(answer: { ok: boolean; status: string }, ms: number): LineText {
	return { kind: answer.ok ? "info" : "error", text: `worker ← ${answer.status} in ${ms} ms` };
}
