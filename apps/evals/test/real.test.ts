// The robustness of the command `npm run evals -- --real` (task 12, requirement N8). The fetch is a fake.
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadRealCases, playAll, type RealOptions, Staging } from "../src/real.js";

const OPTIONS: RealOptions = {
	url: "https://staging.example",
	adminToken: "admin-token",
	launcherKey: "launcher-key",
	runs: 1,
	log: () => undefined,
	retryWaitMs: 1,
};

// A fetch that throws as a socket that the other side closed, for the first `failures` calls.
function flakyFetch(failures: number, answer: () => Response) {
	const calls: { url: string; method: string; body: string | undefined }[] = [];
	const fake = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body?.toString() });
		if (calls.length <= failures) throw new TypeError("fetch failed");
		return answer();
	};
	return { calls, fetch: fake };
}

const json = (value: unknown) => () => new Response(JSON.stringify(value), { status: 200 });

test("N8: the real evals try a GET again after a failed fetch, up to three more times", async () => {
	const three = flakyFetch(3, json({ messages: [{ seq: 4, type: "reply", text: "ok" }] }));
	assert.equal(await new Staging({ ...OPTIONS, fetch: three.fetch }).lastSeq("acc-1"), 4);
	assert.equal(three.calls.length, 4);
	const four = flakyFetch(4, json({ messages: [] }));
	await assert.rejects(new Staging({ ...OPTIONS, fetch: four.fetch }).lastSeq("acc-1"), /fetch failed/);
	assert.equal(four.calls.length, 4);
});

test("N8: the real evals send a command again with the same body and command id after a failed fetch", async () => {
	const flaky = flakyFetch(2, json({ status: "accepted" }));
	const staging = new Staging({ ...OPTIONS, fetch: flaky.fetch });
	await staging.owner("acc-1", { type: "OwnerMessage", commandId: "acc-1-step-0", text: "Hello" });
	assert.equal(flaky.calls.length, 3);
	assert.deepEqual(new Set(flaky.calls.map((call) => call.method)), new Set(["POST"]));
	assert.equal(new Set(flaky.calls.map((call) => call.body)).size, 1, "Each try sends the same body.");
	assert.equal(JSON.parse(flaky.calls[0]?.body ?? "{}").commandId, "acc-1-step-0");
});

test("N8: a run that fails is marked fail with its reason, and the next case runs", async () => {
	const [first, second] = loadRealCases();
	assert.ok(first && second);
	const played: string[] = [];
	const results = await playAll(OPTIONS, [first, second], "stamp", async (item, accountId) => {
		played.push(item.id);
		if (item.id === first.id) throw new TypeError("fetch failed");
		return { caseId: item.id, runNo: 0, verdict: "pass", reasons: [], cost: 0, ms: 1, accountId };
	});
	assert.deepEqual(played, [first.id, second.id]);
	assert.deepEqual(
		results.map((result) => [result.caseId, result.runNo, result.verdict, result.reasons]),
		[
			[first.id, 1, "fail", ["The run stopped: fetch failed"]],
			[second.id, 1, "pass", []],
		],
	);
});

test("N8: the real evals try a call again after a server error, and a task read that keeps failing stops the run with its reason", async () => {
	let calls = 0;
	const fetch: typeof globalThis.fetch = async () => {
		calls += 1;
		return new Response("{}", { status: calls < 3 ? 503 : 401 });
	};
	const s = new Staging({
		url: "https://staging.test",
		adminToken: "admin",
		launcherKey: "k",
		runs: 1,
		log: () => {},
		fetch,
		retryWaitMs: 1,
	});
	await assert.rejects(s.tasks("eval-1", ["eval-1-step-0"]), /The status of the task eval-1-step-0 failed with 401\./);
	assert.equal(calls, 3, "two server errors, then the answer 401");
});
