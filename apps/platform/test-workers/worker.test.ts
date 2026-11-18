// The tests of the Worker and the two Durable Objects, inside the Workers runtime.
import { TEST_TOKENS } from "@tensquads/adapters-test";
import {
	acceptedAnswer,
	apiError,
	OWNER_MESSAGE_TYPES,
	ownerMessage as ownerMessageSchema,
} from "@tensquads/contracts";
import { beforeAll, describe, expect, test } from "vitest";

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
			[
				post("/v1/commands", TEST_TOKENS.ownerA, { type: "ForgetFact", commandId: "w4-d", at: AT, factId: "f" }),
				400,
				"not_available",
			],
			[post("/v1/commands", TEST_TOKENS.ownerB, ownerMessage("w4-e", "x")), 403, "forbidden"],
			[post("/v1/admin/commands", TEST_TOKENS.ownerA, { type: "CreateAccount" }), 404, "not_found"],
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

	test("W3: the list and the stream give the same messages in the same sequence, and a client continues from its last number", async () => {
		await post("/v1/commands", TEST_TOKENS.ownerA, ownerMessage("w3-1", "first"));
		// Earlier tests start tasks, and their replies can come late. The list is complete when it is stable.
		const listed = await settledMessages(TEST_TOKENS.ownerA, 0);
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

	test("isolation: owner B gets no message of account A", async () => {
		const response = await call("/v1/messages?after=0", TEST_TOKENS.ownerB);
		expect(await response.json()).toEqual({ messages: [] });
	});
});
