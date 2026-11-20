"use client";

import { type PlatformOwnerCommandBody, withCommandMeta } from "@tensquads/ui/schemas";
import { useRef, useState } from "react";

import {
	type ActivityLine,
	arrivalLines,
	openWatched,
	sendResultLine,
	type TaskState,
	type TaskWatch,
	taskUpdate,
	watchTasks,
} from "./activity";
import { mergeMessages, type WorkerMessage } from "./owner-messages";
import { type PetraStep, type StepWatch, stepUpdate, watchCommand, watchedCommands } from "./petra-steps";
import { useMountEffect } from "./use-mount-effect";

const POLL_MS = 1500;
const TOKEN_KEY = "tensquads-owner-token";

// The owner calls of the Worker, through the proxy route of this app.
function workerCall(token: string, path: string, body?: unknown): Promise<Response> {
	return fetch(`/api/worker/${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		cache: "no-store",
	});
}

// The new messages after a seq, "unauthorized", or nothing when the call failed.
async function readMessages(token: string, after: number): Promise<WorkerMessage[] | "unauthorized" | undefined> {
	try {
		const response = await workerCall(token, `v1/messages?after=${after}`);
		if (response.status === 401) return "unauthorized";
		return response.ok ? ((await response.json()) as { messages: WorkerMessage[] }).messages : undefined;
	} catch {
		return undefined;
	}
}

// The state of one task, or nothing when the call failed.
async function readTask(token: string, taskId: string): Promise<TaskState | undefined> {
	try {
		const response = await workerCall(token, `v1/tasks/${encodeURIComponent(taskId)}`);
		return response.ok ? ((await response.json()) as TaskState) : undefined;
	} catch {
		return undefined;
	}
}

// The internal steps of Petra for one command, or nothing when the call failed.
async function readSteps(token: string, commandId: string): Promise<PetraStep[] | undefined> {
	try {
		const response = await workerCall(token, `v1/commands/${encodeURIComponent(commandId)}/steps`);
		return response.ok ? ((await response.json()) as { steps: PetraStep[] }).steps : undefined;
	} catch {
		return undefined;
	}
}

const MAX_LINES = 300;
const clock = () => new Date().toISOString().slice(11, 23);

interface SendAnswer {
	ok: boolean;
	status: string;
	commandId: string;
}

// One command with its id and time. A failed network call is sent again with the same command id.
async function sendCommand(token: string, body: PlatformOwnerCommandBody): Promise<SendAnswer> {
	const commandId = crypto.randomUUID();
	const command = withCommandMeta(body, { commandId, at: new Date().toISOString() });
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const response = await workerCall(token, "v1/commands", command).catch(() => undefined);
		if (response) return { ok: response.ok, status: String(response.status), commandId };
	}
	return { ok: false, status: "network error", commandId };
}

function scrollToEnd() {
	requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
}

// The session of the owner: the token, the messages of Petra, the texts sent in this tab, and the poll.
export function useOwnerSession() {
	const [token, setToken] = useState<string | null>(null);
	const [messages, setMessages] = useState<WorkerMessage[]>([]);
	// The owner messages of this tab. Each one shows after the newest message of Petra at the time it was sent.
	const [sent, setSent] = useState<{ afterSeq: number; text: string }[]>([]);
	const [waitingFrom, setWaitingFrom] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const timer = useRef<ReturnType<typeof setInterval> | null>(null);
	const lastSeq = useRef(0);
	// The activity panel: what the page sends and gets, and the state of each task that runs.
	const [activity, setActivity] = useState<ActivityLine[]>([]);
	const sentAt = useRef<number | null>(null);
	const watched = useRef<TaskWatch>(new Map());
	// The commands that this page sent, for the internal steps of Petra.
	const commands = useRef<StepWatch>(new Map());

	const lineId = useRef(0);
	const loaded = useRef(false);

	function log(kind: ActivityLine["kind"], text: string, at = clock()) {
		lineId.current += 1;
		const line = { id: lineId.current, at, kind, text };
		setActivity((lines) => [...lines.slice(-(MAX_LINES - 1)), line]);
	}

	// Reads each watched task, and writes a line when its state changed.
	async function pollTasks(current: string) {
		for (const taskId of openWatched(watched.current)) {
			const line = taskUpdate(watched.current, await readTask(current, taskId));
			if (line) log("task", line);
		}
	}

	// Reads the steps of each watched command, and writes a line for each new step.
	async function pollSteps(current: string) {
		for (const commandId of watchedCommands(commands.current, Date.now())) {
			const steps = await readSteps(current, commandId);
			if (!steps) continue;
			for (const line of stepUpdate(commands.current, commandId, steps, Date.now()))
				log(line.kind, line.text, line.at);
		}
	}

	// The activity lines of one read. The first read of a session is the history: one summary line, no task watch.
	function noteArrival(fresh: readonly WorkerMessage[]) {
		const first = !loaded.current;
		loaded.current = true;
		const wait = sentAt.current === null ? null : Date.now() - sentAt.current;
		for (const line of arrivalLines(fresh, first, wait)) log(line.kind, line.text);
		if (!first) watchTasks(watched.current, fresh);
	}

	async function poll(current: string) {
		const fresh = await readMessages(current, lastSeq.current);
		if (fresh === "unauthorized") return signOut("This token is not valid.");
		await pollTasks(current);
		await pollSteps(current);
		if (!fresh) return;
		noteArrival(fresh);
		const last = fresh.at(-1);
		if (!last) return;
		lastSeq.current = Math.max(lastSeq.current, last.seq);
		setMessages((list) => mergeMessages(list, fresh));
		setWaitingFrom((from) => (from !== null && last.seq > from ? null : from));
		scrollToEnd();
	}

	function stopPolling() {
		if (timer.current) clearInterval(timer.current);
		timer.current = null;
	}

	function signIn(next: string) {
		stopPolling();
		lastSeq.current = 0;
		setMessages([]);
		setSent([]);
		setActivity([]);
		watched.current.clear();
		commands.current.clear();
		loaded.current = false;
		setError(null);
		setToken(next);
		sessionStorage.setItem(TOKEN_KEY, next);
		void poll(next);
		timer.current = setInterval(() => void poll(next), POLL_MS);
	}

	function signOut(reason: string | null = null) {
		stopPolling();
		sessionStorage.removeItem(TOKEN_KEY);
		setToken(null);
		setMessages([]);
		setError(reason);
	}

	// The token of this browser tab survives a reload. The poll stops when the page closes.
	useMountEffect(() => {
		const saved = sessionStorage.getItem(TOKEN_KEY);
		if (saved) signIn(saved);
		return stopPolling;
	});

	async function send(body: PlatformOwnerCommandBody, text?: string) {
		if (!token) return;
		setError(null);
		setWaitingFrom(lastSeq.current);
		if (text) setSent((list) => [...list, { afterSeq: lastSeq.current, text }]);
		scrollToEnd();
		sentAt.current = Date.now();
		log("send", `page → POST /v1/commands ${body.type}`);
		const answer = await sendCommand(token, body);
		const result = sendResultLine(answer, Date.now() - sentAt.current);
		log(result.kind, result.text);
		if (answer.ok) {
			watchCommand(commands.current, answer.commandId, Date.now());
			return;
		}
		setWaitingFrom(null);
		setError("The message did not reach Petra. Try again.");
	}

	return { token, messages, sent, activity, thinking: waitingFrom !== null, error, signIn, signOut, send };
}
