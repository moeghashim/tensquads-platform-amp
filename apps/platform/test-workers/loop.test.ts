// The gateway and the launcher calls through the Worker, in the Workers runtime (task 04).
import { TEST_TOKENS } from "@tensquads/adapters-test";
import { type PassClaims, startAnswer, taskStatusAnswer } from "@tensquads/contracts";
import { signPass } from "@tensquads/gateway";
import { beforeAll, describe, expect, test } from "vitest";

import { AT, call, ownerMessage, post, setUpAccountA } from "./helpers.js";

const PASS_KEY = "test-pass-key";
const LAUNCHER_KEY = "test-launcher-key";

beforeAll(setUpAccountA);

interface Taken {
	accountId: string;
	taskId: string;
	attemptNo: number;
	pass: string;
}

// Takes requests until the request of this task and attempt comes. Other requests of the list are taken too.
async function takeFor(taskId: string, attemptNo: number): Promise<Taken> {
	for (let i = 0; i < 60; i++) {
		const response = await post("/v1/launcher/take", LAUNCHER_KEY, {});
		if (response.status === 200) {
			const { request } = (await response.json()) as { request: Taken };
			if (request.taskId === taskId && request.attemptNo === attemptNo) return request;
		} else {
			expect(response.status).toBe(204);
		}
	}
	throw new Error(`No request for ${taskId}/${attemptNo}.`);
}

function gateway(pass: string, body: unknown): Promise<Response> {
	return post("/v1/gateway", pass, body);
}

const startCall = (callNo: number, runnerId: string) => ({
	call: "start",
	callNo,
	runnerId,
	runnerCommit: "runner-abc",
	pluginListHash: "plugins-abc",
});

const report = (taskId: string, attemptNo: number, exitCode: number) =>
	post("/v1/launcher/report", LAUNCHER_KEY, { accountId: "account-a", taskId, attemptNo, exitCode });

async function taskStatus(taskId: string) {
	return taskStatusAnswer.parse(await (await call(`/v1/tasks/${taskId}`, TEST_TOKENS.ownerA)).json());
}

async function untilStatus(taskId: string, status: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		const response = await call(`/v1/tasks/${taskId}`, TEST_TOKENS.ownerA);
		if (response.ok && ((await response.json()) as { status: string }).status === status) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`The task ${taskId} did not get the status ${status}.`);
}

describe("the gateway and the launcher through the Worker", () => {
	test("L12: the launcher calls need the key of the launcher, and a refusal has no detail", async () => {
		for (const path of ["/v1/launcher/take", "/v1/launcher/report"]) {
			const response = await post(path, "wrong-key", {});
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ code: "unauthorized", message: "Unauthorized." });
		}
	});

	test("L9, L7, L5: a task through the gateway; a pass of a different task, of an old attempt, of a task that ended, or after its end time is refused", async () => {
		await post("/v1/commands", TEST_TOKENS.ownerA, ownerMessage("l9", "Answer the question of the customer."));
		const first = await takeFor("l9", 1);
		expect(first.accountId).toBe("account-a");

		// The first start binds the runner. The task runs.
		const started = await gateway(first.pass, startCall(1, "runner-1"));
		expect(started.status).toBe(200);
		expect(startAnswer.parse(await started.json()).taskType).toBe("answer-question");
		const model = await gateway(first.pass, {
			call: "model",
			callNo: 2,
			runnerId: "runner-1",
			turnNo: 1,
			messages: [{ role: "user", content: "hello" }],
			tools: [],
		});
		expect(model.status).toBe(200);

		// L7: the status of the task comes from its trail rows.
		const status = await taskStatus("l9");
		expect(status.status).toBe("running");
		expect(status.activity).toMatchObject({ taskId: "l9", bot: "test-bot", attemptNo: 1, turnNo: 1 });

		// L5: the report comes two times. The task gets one new attempt.
		expect((await report("l9", 1, 1)).status).toBe(200);
		expect((await report("l9", 1, 1)).status).toBe(200);
		const second = await takeFor("l9", 2);

		// L9: a pass of an old attempt.
		const old = await gateway(first.pass, { call: "inbox", callNo: 3, runnerId: "runner-1" });
		expect({ status: old.status, body: await old.json() }).toEqual({ status: 403, body: { refused: "attempt" } });

		// L9: a pass of a different task. Only Petra knows that the task is not this one.
		const endsAt = Date.now() + 60_000;
		const otherTask: PassClaims = {
			accountId: "account-a",
			bot: "test-bot",
			taskId: "no-such-task",
			attemptNo: 1,
			endsAt,
		};
		const other = await gateway(await signPass(otherTask, PASS_KEY), startCall(1, "runner-x"));
		expect({ status: other.status, body: await other.json() }).toEqual({ status: 403, body: { refused: "task" } });

		// L9: a pass after its end time. The Worker refuses it with no detail, before a Durable Object.
		const late = await signPass({ ...otherTask, taskId: "l9", attemptNo: 2, endsAt: Date.now() - 1 }, PASS_KEY);
		const expired = await gateway(late, startCall(1, "runner-2"));
		expect({ status: expired.status, body: await expired.json() }).toEqual({
			status: 401,
			body: { code: "unauthorized", message: "Unauthorized." },
		});
		// A pass with a wrong signature gets the same refusal.
		const forged = await gateway(`${second.pass.split(".")[0]}.AAAA`, startCall(1, "runner-2"));
		expect(forged.status).toBe(401);

		// L9: a pass of a task that ended. The owner cancels the task.
		const cancel = { type: "CancelTask", commandId: "l9-cancel", at: AT, taskId: "l9" };
		expect((await post("/v1/commands", TEST_TOKENS.ownerA, cancel)).status).toBe(200);
		await untilStatus("l9", "cancelled");
		const ended = await gateway(second.pass, startCall(1, "runner-2"));
		expect({ status: ended.status, body: await ended.json() }).toEqual({ status: 403, body: { refused: "task" } });
	});
});
