import assert from "node:assert/strict";
import { test } from "node:test";

import { type RunnerChild, type SandboxRequest, startLauncher } from "../src/launcher.js";

const TIMEOUT = { timeout: 10_000 };

function passFor(endsAt: number): string {
	const claims = { accountId: "acc-1", bot: "test-bot", taskId: "task-1", attemptNo: 1, endsAt };
	return `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

// A fake runner. The test ends it with an exit code, or the launcher kills it.
class FakeChild implements RunnerChild {
	killed = false;
	exit!: (code: number) => void;
	readonly exited = new Promise<number>((resolve) => {
		this.exit = resolve;
	});

	kill(): void {
		this.killed = true;
		this.exit(143);
	}
}

// A fake Platform Worker. Each take gives the next request of the list, or 204 when the list is empty.
function fakeWorker(requests: SandboxRequest[]) {
	const reports: unknown[] = [];
	const keys: (string | null)[] = [];
	let takes = 0;
	let reported: () => void = () => {};
	const fakeFetch: typeof fetch = async (input, init) => {
		keys.push(new Headers(init?.headers).get("authorization"));
		const url = String(input);
		if (url === "http://worker.test/v1/launcher/take") {
			takes += 1;
			const request = requests.shift();
			if (request === undefined) {
				// The real call waits a short time before 204.
				await new Promise((resolve) => setTimeout(resolve, 5));
				return new Response(null, { status: 204 });
			}
			return Response.json({ request });
		}
		if (url === "http://worker.test/v1/launcher/report") {
			reports.push(JSON.parse(String(init?.body)));
			reported();
			return Response.json({ ok: true });
		}
		return new Response(null, { status: 404 });
	};
	const nextReport = () =>
		new Promise<void>((resolve) => {
			reported = resolve;
		});
	return { fakeFetch, reports, keys, nextReport, takes: () => takes };
}

function request(pass: string, attemptNo = 1): SandboxRequest {
	return { accountId: "acc-1", taskId: "task-1", attemptNo, pass };
}

test("L12: one take starts one runner with the pass, and the launcher reports its exit code", TIMEOUT, async () => {
	const pass = passFor(Date.now() + 60_000);
	const worker = fakeWorker([request(pass)]);
	const spawned: { pass: string; child: FakeChild }[] = [];
	const launcher = startLauncher({
		workerUrl: "http://worker.test/",
		launcherKey: "launcher-key",
		fetch: worker.fakeFetch,
		spawn: (p) => {
			const child = new FakeChild();
			spawned.push({ pass: p, child });
			return child;
		},
		retryDelayMs: 0,
	});
	const reported = worker.nextReport();
	while (spawned.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
	spawned[0]?.child.exit(0);
	await reported;
	await launcher.stop();
	assert.equal(spawned.length, 1);
	assert.equal(spawned[0]?.pass, pass);
	assert.equal(spawned[0]?.child.killed, false);
	assert.deepEqual(worker.reports, [{ accountId: "acc-1", taskId: "task-1", attemptNo: 1, exitCode: 0 }]);
	assert.ok(worker.keys.every((key) => key === "Bearer launcher-key"));
});

test("L12: a take that answers 204 starts no runner", TIMEOUT, async () => {
	const worker = fakeWorker([]);
	let spawns = 0;
	const launcher = startLauncher({
		workerUrl: "http://worker.test",
		launcherKey: "launcher-key",
		fetch: worker.fakeFetch,
		spawn: () => {
			spawns += 1;
			return new FakeChild();
		},
		retryDelayMs: 0,
	});
	while (worker.takes() < 3) await new Promise((resolve) => setTimeout(resolve, 1));
	await launcher.stop();
	assert.equal(spawns, 0);
	assert.deepEqual(worker.reports, []);
});

test("L12: the launcher kills a runner at the end time of its pass and reports the exit code", TIMEOUT, async () => {
	const worker = fakeWorker([request(passFor(Date.now() + 50))]);
	const children: FakeChild[] = [];
	const launcher = startLauncher({
		workerUrl: "http://worker.test",
		launcherKey: "launcher-key",
		fetch: worker.fakeFetch,
		spawn: () => {
			const child = new FakeChild();
			children.push(child);
			return child;
		},
		retryDelayMs: 0,
	});
	await worker.nextReport();
	await launcher.stop();
	assert.equal(children.length, 1);
	assert.equal(children[0]?.killed, true);
	assert.deepEqual(worker.reports, [{ accountId: "acc-1", taskId: "task-1", attemptNo: 1, exitCode: 143 }]);
});

test("L12: several runners run at the same time, and stop waits for each one", TIMEOUT, async () => {
	const endsAt = Date.now() + 60_000;
	const worker = fakeWorker([request(passFor(endsAt), 1), request(passFor(endsAt), 2)]);
	const children: FakeChild[] = [];
	const launcher = startLauncher({
		workerUrl: "http://worker.test",
		launcherKey: "launcher-key",
		fetch: worker.fakeFetch,
		spawn: () => {
			const child = new FakeChild();
			children.push(child);
			return child;
		},
		retryDelayMs: 0,
	});
	while (children.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
	let stopped = false;
	const stopping = launcher.stop().then(() => {
		stopped = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(stopped, false);
	children[0]?.exit(0);
	children[1]?.exit(3);
	await stopping;
	const codes = worker.reports.map((r) => (r as { attemptNo: number; exitCode: number }).exitCode).sort();
	assert.deepEqual(codes, [0, 3]);
});

test("the launcher stops when the Worker refuses its key", TIMEOUT, async () => {
	const fakeFetch: typeof fetch = async () => new Response(null, { status: 401 });
	const launcher = startLauncher({
		workerUrl: "http://worker.test",
		launcherKey: "bad",
		fetch: fakeFetch,
		spawn: () => new FakeChild(),
		retryDelayMs: 0,
	});
	await assert.rejects(launcher.done, /refused the setting LAUNCHER_KEY/);
});
