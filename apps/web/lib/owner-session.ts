"use client";

import { type PlatformOwnerCommandBody, withCommandMeta } from "@tensquads/ui/schemas";
import { useRef, useState } from "react";

import { mergeMessages, type WorkerMessage } from "./owner-messages";
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

// One command with its id and time. A failed network call is sent again with the same command id.
async function sendCommand(token: string, body: PlatformOwnerCommandBody): Promise<boolean> {
	const command = withCommandMeta(body, { commandId: crypto.randomUUID(), at: new Date().toISOString() });
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const response = await workerCall(token, "v1/commands", command).catch(() => undefined);
		if (response) return response.ok;
	}
	return false;
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

	async function poll(current: string) {
		const fresh = await readMessages(current, lastSeq.current);
		if (fresh === "unauthorized") return signOut("This token is not valid.");
		const last = fresh?.at(-1);
		if (!fresh || !last) return;
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
		if (!(await sendCommand(token, body))) {
			setWaitingFrom(null);
			setError("The message did not reach Petra. Try again.");
		}
	}

	return { token, messages, sent, thinking: waitingFrom !== null, error, signIn, signOut, send };
}
