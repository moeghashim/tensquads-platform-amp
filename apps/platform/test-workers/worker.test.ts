// The tests of the Worker and the two Durable Objects, inside the Workers runtime.

import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { TEST_TOKENS } from "@tensquads/adapters-test";
import {
	acceptedAnswer,
	apiError,
	commandStepsAnswer,
	OWNER_MESSAGE_TYPES,
	ownerMessage as ownerMessageSchema,
} from "@tensquads/contracts";
import type { JobMessage } from "@tensquads/petra";
import { beforeAll, describe, expect, test } from "vitest";

import type { Env } from "../src/env.js";
import worker from "../src/index.js";

import {
	AT,
	call,
	openStream,
	ownerMessage,
	post,
	settledMessages,
	setUpAccountA,
	until,
	waitForMessages,
} from "./helpers.js";

beforeAll(setUpAccountA);

describe("the interface of the Platform Worker", () => {
	test("W2: a command gets one call and the answer accepted, with its command id. The same id gives the same answer", async () => {
		const first = await post("/v1/commands", TEST_TOKENS.ownerA, ownerMessage("w2", "hello"));
		const second = await post("/v1/commands", TEST_TOKENS.ownerA, ownerMessage("w2", "hello"));
		const answers = [await first.json(), await second.json()];
		expect(answers).toEqual([
			{ status: "accepted", commandId: "w2" },
			{ status: "accepted", commandId: "w2" },
		]);
		expect(acceptedAnswer.safeParse(answers[0]).success).toBe(true);
	});

	test("W1: each answer of the interface passes its schema in contracts", async () => {
		const list = (await (await call("/v1/messages?after=0", TEST_TOKENS.ownerA)).json()) as { messages: unknown[] };
		for (const message of list.messages) {
			expect(ownerMessageSchema.safeParse(message).success).toBe(true);
		}
		const task = await call("/v1/tasks/no-such-task", TEST_TOKENS.ownerA);
		expect(task.status).toBe(404);
		expect(apiError.parse(await task.json()).code).toBe("not_found");
	});

	test("W4: each error has only a code and a message, and a call with no sign-in gets no detail", async () => {
		const cases: [Promise<Response>, number, string][] = [
			[post("/v1/commands", undefined, ownerMessage("w4-a", "x")), 401, "unauthorized"],
			[post("/v1/commands", "not-a-token", ownerMessage("w4-b", "x")), 401, "unauthorized"],
			[post("/v1/commands", TEST_TOKENS.ownerA, { type: "OwnerMessage" }), 400, "invalid_request"],
			[
				post("/v1/commands", TEST_TOKENS.ownerA, { ...ownerMessage("w4-c", "x"), accountId: "account-b" }),
				400,
				"invalid_request",
			],
			// Each admin command has a handler since task 10. A command that does not pass its schema is not valid.
			[post("/v1/admin/commands", TEST_TOKENS.superAdmin, { type: "SetUnitPrice" }), 400, "invalid_request"],
			[post("/v1/commands", TEST_TOKENS.ownerB, ownerMessage("w4-e", "x")), 403, "forbidden"],
			// An owner cannot use an admin call (requirement S8).
			[post("/v1/admin/commands", TEST_TOKENS.ownerA, { type: "CreateAccount" }), 403, "forbidden"],
			[call("/v1/nothing", TEST_TOKENS.ownerA), 404, "not_found"],
		];
		for (const [pending, status, code] of cases) {
			const response = await pending;
			const body = await response.json();
			expect({ status: response.status, body }).toEqual({ status, body: { code, message: expect.any(String) } });
		}
		const unauthorized = (await (await call("/v1/messages", undefined)).json()) as { message: string };
		expect(unauthorized.message).toBe("Unauthorized.");
	});

	test("W1 and W4: the steps of a command give the model calls, the tool runs, the decisions and the costs of the account only", async () => {
		const text = "What did the squad do today?";
		await post("/v1/commands", TEST_TOKENS.ownerA, ownerMessage("steps-1", text));
		await settledMessages(TEST_TOKENS.ownerA, 0, "I started the task steps-1.");
		let body = "";
		await until(async () => {
			body = await (await call("/v1/commands/steps-1/steps", TEST_TOKENS.ownerA)).text();
			return body.includes('"tool":"start_task"') && body.includes('"kind":"cost"');
		}, "the steps of the command");
		const answer = commandStepsAnswer.parse(JSON.parse(body));
		expect(answer.commandId).toBe("steps-1");
		const kinds = new Set(answer.steps.map((step) => step.kind));
		expect([...kinds].sort()).toEqual(["cost", "decision", "model", "tool"]);
		const times = answer.steps.map((step) => step.at);
		expect(times).toEqual([...times].sort());
		const model = answer.steps.find((step) => step.kind === "model");
		expect(model).toMatchObject({ provider: "test", tools: ["start_task"], failed: false });
		expect(answer.steps.filter((step) => step.kind === "decision").map((step) => step.point)).toContain(
			"request-clear",
		);
		// A step has no text of the owner message.
		expect(body).not.toContain(text);

		// A command with no step gives an empty list. Another account never sees the steps of account A.
		const none = await call("/v1/commands/no-such-command/steps", TEST_TOKENS.ownerA);
		expect(await none.json()).toEqual({ commandId: "no-such-command", steps: [] });
		const other = await call("/v1/commands/steps-1/steps", TEST_TOKENS.ownerB);
		expect(await other.text()).not.toContain("start_task");
		// A super admin cannot use the owner call (requirement S8).
		expect((await call("/v1/commands/steps-1/steps", TEST_TOKENS.superAdmin)).status).toBe(403);
	});

	test("W3: the list and the stream give the same messages in the same sequence, and a client continues from its last number", async () => {
		await post("/v1/commands", TEST_TOKENS.ownerA, ownerMessage("w3-1", "first"));
		// Earlier tests start tasks, and their replies can come late. The list is complete when it has the reply of w3-1.
		const listed = await settledMessages(TEST_TOKENS.ownerA, 0, "I started the task w3-1.");
		const stream = await openStream(TEST_TOKENS.ownerA, 0);
		await until(() => stream.received.length >= listed.length, "the backlog on the stream");
		expect(stream.received).toEqual(listed);

		// A new message comes on the open stream after it is in the database.
		await post("/v1/commands", TEST_TOKENS.ownerA, ownerMessage("w3-2", "second"));
		await until(() => stream.received.length === listed.length + 1, "the new message on the stream");
		const last = listed.at(-1)?.seq ?? 0;
		expect(await waitForMessages(TEST_TOKENS.ownerA, last, 1)).toEqual(stream.received.slice(listed.length));
		stream.socket.close(1000, "done");

		// The client lost the stream. It connects again with its last number and gets only the newer messages.
		const again = await openStream(TEST_TOKENS.ownerA, last);
		await until(() => again.received.length === 1, "the message after the last number");
		expect(again.received).toEqual(stream.received.slice(listed.length));
		again.socket.close(1000, "done");
	});

	test("D12: the queue events gives an ExternalEvent to the Petra of its account, and drops each other command", async () => {
		const before = await waitForMessages(TEST_TOKENS.ownerA, 0, 0);
		const last = before.at(-1)?.seq ?? 0;
		const event = {
			type: "ExternalEvent",
			commandId: "d12-event",
			at: AT,
			eventId: "d12-event",
			source: "whatsapp",
			eventType: "message",
			sender: "+966500000000",
			payload: { text: "Hello" },
		};
		// A command of the owner in the queue of outside events is not trusted. It must not start a task.
		const command = { ...ownerMessage("d12-owner", "Please read 1 file."), messageId: "m-d12-owner" };
		const batch = createMessageBatch("events", [
			{ id: "d12-1", timestamp: Date.parse(AT), attempts: 1, body: { accountId: "account-a", command: event } },
			{ id: "d12-2", timestamp: Date.parse(AT), attempts: 1, body: { accountId: "account-a", command } },
		]);
		const ctx = createExecutionContext();
		// The test env has the bindings of wrangler.jsonc. Its global type is empty, so the test gives it the type of the Worker.
		await worker.queue(batch as MessageBatch<JobMessage>, env as unknown as Env);
		const result = await getQueueResult(batch, ctx);
		expect(result.explicitAcks.sort()).toEqual(["d12-1", "d12-2"]);
		expect(result.retryMessages).toEqual([]);
		// Petra handles a later command of the owner. When its reply is in the list, the dropped command had its turn.
		await post("/v1/commands", TEST_TOKENS.ownerA, ownerMessage("d12-after", "What did the squad do today?"));
		const messages = await settledMessages(TEST_TOKENS.ownerA, last, "I started the task d12-after.");
		expect(JSON.stringify(messages)).not.toContain("d12-owner");
	});

	test("O3: the fixed demo runs, and each message that Petra sends passes its schema", async () => {
		const before = await waitForMessages(TEST_TOKENS.ownerA, 0, 0);
		const last = before.at(-1)?.seq ?? 0;
		await post("/v1/commands", TEST_TOKENS.ownerA, ownerMessage("o3", "What did the squad do today?"));
		// A reply of an earlier command can come first. The test waits for the reply of this command.
		let messages: unknown[] = [];
		for (let i = 0; i < 100; i++) {
			messages = await waitForMessages(TEST_TOKENS.ownerA, last, 1);
			if (JSON.stringify(messages).includes("I started the task o3.")) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(messages.length).toBeGreaterThan(0);
		for (const message of messages) {
			const parsed = ownerMessageSchema.safeParse(message);
			expect(parsed.success).toBe(true);
			expect(OWNER_MESSAGE_TYPES).toContain(parsed.data?.type);
		}
		const texts = messages
			.map((message) => ownerMessageSchema.parse(message))
			.flatMap((m) => (m.type === "reply" ? [m.text] : []));
		// The rule model of Petra starts a task of the test bot for this message. The task id is the command id.
		expect(texts).toContain("I started the task o3.");
	});

	test("G2: the Worker accepts the commands SetRule and ApprovalDecision of an owner", async () => {
		const rule = {
			type: "SetRule",
			commandId: "g2-rule",
			at: AT,
			rule: { kind: "money_limit", params: { maxAmount: 20_000_000 } },
		};
		// An approval of an action that does not exist does nothing. The command is still accepted.
		const approval = {
			type: "ApprovalDecision",
			commandId: "g2-approval",
			at: AT,
			approvalId: "no-task/call-1",
			decision: "approve",
			contentHash: "0".repeat(64),
		};
		for (const command of [rule, approval]) {
			const response = await post("/v1/commands", TEST_TOKENS.ownerA, command);
			expect({ status: response.status, body: await response.json() }).toEqual({
				status: 200,
				body: { status: "accepted", commandId: command.commandId },
			});
		}
	});

	test("isolation: owner B gets no message of account A", async () => {
		const response = await call("/v1/messages?after=0", TEST_TOKENS.ownerB);
		expect(await response.json()).toEqual({ messages: [] });
	});
});
