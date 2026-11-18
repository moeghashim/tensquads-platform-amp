import assert from "node:assert/strict";
import { test } from "node:test";
import { type GatewayCall, gatewayCall } from "@tensquads/contracts";

import { type HttpLinkOptions, httpLink, type RefusalReason } from "../src/index.js";

class Refused extends Error {
	constructor(
		readonly reason: RefusalReason,
		readonly call: string,
	) {
		super(`refused ${call} ${reason}`);
	}
}

// One answer of the fake Worker: a status and a body, or a network error.
type Reply = { status: number; body?: unknown } | "network error";

const ok = { status: 200, body: { ok: true } };

const modelBody = {
	text: "hello",
	toolCalls: [{ id: "c-1", name: "read_file", input: { path: "a" } }],
	provider: "fake",
	model: "fake",
	usage: { inputTokens: 1, outputTokens: 2 },
};

const startBody = {
	brief: {
		goal: "Answer.",
		done: "Answered.",
		facts: [],
		limits: { maxTurns: 10, maxBudget: 0.5 },
		notInTask: [],
		replyTo: "owner-1",
	},
	taskType: "answer-question",
	forget: [],
	journal: null,
	signals: [],
};

interface Seen {
	url: string;
	authorization: string | null;
	call: GatewayCall;
}

// A fake Worker. It gives the replies in sequence and keeps each request.
function fakeWorker(replies: Reply[]) {
	const seen: Seen[] = [];
	const fakeFetch: typeof fetch = async (input, init) => {
		const headers = new Headers(init?.headers);
		seen.push({
			url: String(input),
			authorization: headers.get("authorization"),
			call: gatewayCall.parse(JSON.parse(String(init?.body))),
		});
		const reply = replies.shift() ?? ok;
		if (reply === "network error") {
			throw new TypeError("fetch failed");
		}
		return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
	};
	return { seen, fakeFetch };
}

function options(fakeFetch: typeof fetch): HttpLinkOptions {
	return {
		workerUrl: "http://worker.test/",
		pass: "pass-token",
		runnerId: "runner-1",
		runnerCommit: "abc123",
		pluginListHash: "hash-1",
		refused: (reason, call) => new Refused(reason, call),
		fetch: fakeFetch,
		retryDelayMs: 0,
	};
}

test("L5: the link counts the calls 1, 2, 3 and sends the pass and the runner id", async () => {
	const { seen, fakeFetch } = fakeWorker([{ status: 200, body: startBody }, ok, ok]);
	const link = httpLink(options(fakeFetch));
	await link.start();
	await link.step({ turnNo: 1, toolCallId: "c-1", tool: "read_file", summary: "text" });
	await link.journal("Y29weQ==");
	assert.deepEqual(
		seen.map((s) => s.call.callNo),
		[1, 2, 3],
	);
	for (const request of seen) {
		assert.equal(request.url, "http://worker.test/v1/gateway");
		assert.equal(request.authorization, "Bearer pass-token");
		assert.equal(request.call.runnerId, "runner-1");
	}
});

test("L11: the start call has the commit of the runner and the hash of its plug-in list", async () => {
	const { seen, fakeFetch } = fakeWorker([{ status: 200, body: startBody }]);
	const answer = await httpLink(options(fakeFetch)).start();
	assert.equal(answer.taskType, "answer-question");
	assert.deepEqual(seen[0]?.call, {
		call: "start",
		callNo: 1,
		runnerId: "runner-1",
		runnerCommit: "abc123",
		pluginListHash: "hash-1",
	});
});

test("L10: the model call goes to the gateway and gives the model answer or the limit", async () => {
	const { seen, fakeFetch } = fakeWorker([
		{ status: 200, body: modelBody },
		{ status: 200, body: { limit: "max_turns" } },
	]);
	const link = httpLink(options(fakeFetch));
	const call = { turnNo: 1, messages: [{ role: "user" as const, content: "hi" }], tools: ["read_file"] };
	assert.deepEqual(await link.model(call), modelBody);
	assert.deepEqual(await link.model({ ...call, turnNo: 2 }), { limit: "max_turns" });
	assert.equal(seen[0]?.call.call, "model");
});

test("L5: after busy, the link sends the same call again with the same call number", async () => {
	const { seen, fakeFetch } = fakeWorker([
		{ status: 200, body: { busy: true } },
		{ status: 200, body: { busy: true } },
		{ status: 200, body: { messages: [], forget: [], signals: [] } },
		ok,
	]);
	const link = httpLink(options(fakeFetch));
	await link.inbox();
	await link.journal("Y29weQ==");
	assert.deepEqual(
		seen.map((s) => [s.call.call, s.call.callNo]),
		[
			["inbox", 1],
			["inbox", 1],
			["inbox", 1],
			["journal", 2],
		],
	);
});

test("L5: after a network error or a server error, the link keeps the call number and gets the saved answer", async () => {
	const { seen, fakeFetch } = fakeWorker([
		{ status: 200, body: startBody },
		"network error",
		{ status: 502 },
		{ status: 200, body: modelBody },
		ok,
	]);
	const link = httpLink(options(fakeFetch));
	await link.start();
	const call = { turnNo: 1, messages: [{ role: "user" as const, content: "hi" }], tools: [] };
	assert.deepEqual(await link.model(call), modelBody);
	await link.step({ turnNo: 1, toolCallId: "c-1", tool: "read_file", summary: "" });
	assert.deepEqual(
		seen.map((s) => s.call.callNo),
		[1, 2, 2, 2, 3],
	);
	// The copy has the same content, so the gateway finds the saved answer of the call.
	assert.deepEqual(seen[1]?.call, seen[3]?.call);
});

test("L5: the link stops after the maximum number of tries", async () => {
	const { seen, fakeFetch } = fakeWorker(["network error", "network error", "network error"]);
	const link = httpLink({ ...options(fakeFetch), maxTries: 3 });
	await assert.rejects(link.inbox(), /The gateway call "inbox" failed after 3 tries/);
	assert.equal(seen.length, 3);
});

test("L9: a refusal of the gateway gives the error of the runner, with the reason", async () => {
	for (const reason of ["runner", "attempt", "task"] as const) {
		const { fakeFetch } = fakeWorker([{ status: 403, body: { refused: reason } }]);
		await assert.rejects(httpLink(options(fakeFetch)).inbox(), (error) => {
			assert.ok(error instanceof Refused);
			assert.equal(error.reason, reason);
			assert.equal(error.call, "inbox");
			return true;
		});
	}
});

test("L9: a 401 with no detail is the refusal of the pass, and the link does not try again", async () => {
	const { seen, fakeFetch } = fakeWorker([{ status: 401 }]);
	await assert.rejects(httpLink(options(fakeFetch)).start(), (error) => {
		assert.ok(error instanceof Refused);
		assert.equal(error.reason, "pass");
		return true;
	});
	assert.equal(seen.length, 1);
});

test("an answer that does not pass its schema is an error", async () => {
	const { fakeFetch } = fakeWorker([{ status: 200, body: { verdict: "maybe" } }]);
	const result = { stop: "success" as const, answer: "a", evidence: [], proposedFacts: [], notes: [] };
	await assert.rejects(httpLink(options(fakeFetch)).result(result), /does not pass its schema/);
});
