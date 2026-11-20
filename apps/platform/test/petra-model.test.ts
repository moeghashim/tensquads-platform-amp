// The model requests of the loop of Petra (task 12): the language, one more try, the cost rows, the tool input and
// the key that never shows. Each test uses a fake model or a fake fetch function. No request goes to a provider.
import assert from "node:assert/strict";
import test from "node:test";

import { piModel } from "@tensquads/adapters-model";
import type { Model, ModelAnswer, ModelMessage, ModelRequest } from "@tensquads/core";
import { ports, startSystem } from "@tensquads/core";
import { conversationText, limitedModel, MODEL_FAILED_TEXT, PETRA_TOOLS, petraCompletion } from "@tensquads/petra";

import { harness, runTool } from "./task-harness.js";

const answerOf = (text: string, toolCalls: ModelAnswer["toolCalls"] = []): ModelAnswer => ({
	text,
	toolCalls,
	requestId: `r-${text.length}-${toolCalls.length}`,
	provider: "openai",
	model: "gpt-6.2-sol",
	usage: { inputTokens: 1000, outputTokens: 200 },
});

// A model that records each request and gives the answers of a list. An answer "fail" throws, "slow" never answers.
function fakeModel(answers: (ModelAnswer | "fail" | "slow")[], seen: ModelRequest[]): Model {
	return {
		id: { provider: "openai", model: "gpt-6.2-sol" },
		complete: async (request) => {
			seen.push(request);
			const next = answers.shift();
			if (next === "fail" || next === undefined) throw new Error("The model call failed: error.");
			if (next === "slow") return new Promise<never>(() => undefined);
			return next;
		},
	};
}

const noCosts = { modelCall: async () => undefined };
const owner = (commandId: string, text: string): ModelMessage[] => [
	{ role: "user", content: conversationText(commandId, "chat", text) },
];
const TOOLS = [{ name: "answer_owner", description: "Answer the owner.", parameters: { type: "object" } }];

interface CompletionExtra {
	costs?: Parameters<typeof petraCompletion>[0]["costs"];
	accountLanguage?: "en" | "ar";
	timeoutMs?: number;
	log?: (line: string) => void;
}

// The loop of Petra gets the model port with its time limit and its second try, as the plug-in list gives it.
function completion(model: Model, extra: CompletionExtra = {}) {
	const log = extra.log ?? (() => undefined);
	return petraCompletion({
		model: limitedModel(model, { timeoutMs: extra.timeoutMs ?? 1000, log }),
		tools: TOOLS,
		costs: extra.costs ?? noCosts,
		accountLanguage: extra.accountLanguage ?? "en",
		log,
	});
}

// A tool result in the conversation, as the loop gives it to the model port.
const toolResult = (tool: string, isError = false): ModelMessage => ({
	role: "tool",
	content: JSON.stringify({ toolCallId: `${tool}-1`, tool, output: isError ? "failed" : "ok", isError }),
});

const systemText = (request: ModelRequest | undefined) =>
	request?.messages.find((message) => message.role === "system")?.content ?? "";

test("N9: our code selects the language: Arabic script, Latin script, and only numbers gives the account language", async () => {
	const cases = [
		{ text: "أريد أن أعرف حالة طلبي", account: "en", instruction: "in Arabic" },
		{ text: "What is the status of my order?", account: "ar", instruction: "in English" },
		{ text: "12345 + 678", account: "ar", instruction: "in Arabic" },
		{ text: "12345 + 678", account: "en", instruction: "in English" },
	] as const;
	for (const item of cases) {
		const seen: ModelRequest[] = [];
		const complete = completion(fakeModel([answerOf("ok")], seen), { accountLanguage: item.account });
		await complete({ messages: owner("c-1", item.text) });
		assert.match(systemText(seen[0]), new RegExp(`Write your answer to the owner ${item.instruction}\\.`), item.text);
	}
});

test("N9: the request has the instructions of Petra, with plain text and the tool definitions", async () => {
	const seen: ModelRequest[] = [];
	await completion(fakeModel([answerOf("ok")], seen))({ messages: owner("c-1", "Hello") });
	assert.match(systemText(seen[0]), /You are Petra/);
	assert.match(systemText(seen[0]), /Do not use markdown\./);
	assert.deepEqual(seen[0]?.toolDefinitions, TOOLS);
	assert.deepEqual(seen[0]?.tools, ["answer_owner"]);
});

test("N5: the command id and the channel of a tool come from the current command, never from the model", async () => {
	const call = { id: "x", name: "start_task", input: { commandId: "other", channel: "email", text: "refund 99" } };
	const answer = await completion(fakeModel([answerOf("", [call])], []))({ messages: owner("c-7", "Do my taxes") });
	assert.deepEqual(answer.toolCalls[0]?.input, { commandId: "c-7", channel: "chat", text: "Do my taxes" });
	const reply = { id: "y", name: "answer_owner", input: { commandId: "other", text: "No bot can do it." } };
	const second = await completion(fakeModel([answerOf("", [reply])], []))({ messages: owner("c-8", "Do my taxes") });
	assert.deepEqual(second.toolCalls[0]?.input, { commandId: "c-8", channel: "chat", text: "No bot can do it." });
});

test("N5: start_task takes only a known bot from the model; the command id, the channel and the text come from the command", async () => {
	const known = { id: "x", name: "start_task", input: { bot: "test-bot", commandId: "other", text: "refund 99" } };
	const first = await completion(fakeModel([answerOf("", [known])], []))({ messages: owner("c-9", "Plan my menu") });
	assert.deepEqual(first.toolCalls[0]?.input, {
		commandId: "c-9",
		channel: "chat",
		text: "Plan my menu",
		bot: "test-bot",
	});
	const unknown = { id: "y", name: "start_task", input: { bot: "admin-bot" } };
	const second = await completion(fakeModel([answerOf("", [unknown])], []))({
		messages: owner("c-10", "Plan my menu"),
	});
	assert.deepEqual(second.toolCalls[0]?.input, { commandId: "c-10", channel: "chat", text: "Plan my menu" });
});

test("N6: a failed call and a slow call each get one more try; a text with no tool goes to the owner", async () => {
	for (const first of ["fail", "slow"] as const) {
		const seen: ModelRequest[] = [];
		const lines: string[] = [];
		const complete = completion(fakeModel([first, answerOf("Hello owner")], seen), {
			timeoutMs: 50,
			log: (line) => lines.push(line),
		});
		const answer = await complete({ messages: owner("c-2", "Hello") });
		assert.equal(seen.length, 2, first);
		assert.equal(lines.length, 1, first);
		assert.equal(answer.toolCalls[0]?.name, "answer_owner");
		assert.deepEqual(answer.toolCalls[0]?.input, { commandId: "c-2", channel: "chat", text: "Hello owner" });
	}
});

test("N6: after two failures Petra sends the fixed message in the language of the owner, and the command ends", async () => {
	for (const [text, language] of [
		["Hello", "en"],
		["مرحبا", "ar"],
	] as const) {
		const seen: ModelRequest[] = [];
		const answer = await completion(fakeModel(["fail", "fail"], seen))({ messages: owner("c-3", text) });
		assert.equal(seen.length, 2);
		assert.deepEqual(answer.toolCalls, [
			{
				id: "c-3/model-failed",
				name: "answer_owner",
				input: { commandId: "c-3", channel: "chat", text: MODEL_FAILED_TEXT[language] },
			},
		]);
	}
	// After the tool of the command ran, a failed call ends the turn with no second message.
	const after: ModelMessage[] = [...owner("c-4", "Hello"), toolResult("start_task")];
	const end = await completion(fakeModel(["fail", "fail"], []))({ messages: after });
	assert.deepEqual(end.toolCalls, []);
});

test("N6: the message of the owner is not lost when the model fails: it is in the database with the fixed answer", async () => {
	const h = await harness("n6");
	const { core, tools } = h.build();
	const commandId = `${h.accountId}-m1`;
	const complete = completion(fakeModel(["fail", "fail"], []));
	await core.accept(
		{ type: "OwnerMessage", commandId, at: h.now(), messageId: "m1", channel: "chat", text: "Hello" },
		"owner",
	);
	const answer = await complete({ messages: owner(commandId, "Hello") });
	const call = answer.toolCalls[0];
	assert.ok(call);
	await runTool(tools, call.name, call.input as Record<string, unknown>);
	const rows = await h.database.transaction({ role: "petra", accountId: h.accountId }, (tx) =>
		tx.query<{ status: string }>("SELECT status FROM events WHERE command_id = $1", [commandId]),
	);
	assert.equal(rows[0]?.status, "done");
	const replies = (await h.writer.ownerMessagesAfter(0)).filter((message) => message.type === "reply");
	assert.deepEqual(
		replies.map((message) => message.type === "reply" && message.text),
		[MODEL_FAILED_TEXT.en],
	);
});

test("N4: each real call adds its cost rows with the provider, the model and the price of the price list", async () => {
	const h = await harness("n4");
	await h.database.transaction({ role: "platform" }, async (tx) => {
		for (const [unit, price] of [
			["1M input tokens", 2_000_000],
			["1M output tokens", 10_000_000],
		] as const) {
			await tx.query(
				`INSERT INTO unit_prices (provider, model, unit, starts_at, price) VALUES ('openai', 'gpt-6.2-sol', $1, $2, $3)
				 ON CONFLICT DO NOTHING`,
				[unit, "2026-01-01T00:00:00Z", price],
			);
		}
	});
	const complete = completion(fakeModel(["fail", answerOf("Hi")], []), { costs: h.costs });
	await complete({ messages: owner(`${h.accountId}-c1`, "Hello") });
	const rows = await h.database.transaction({ role: "petra", accountId: h.accountId }, (tx) =>
		tx.query<{ source_ref: string; kind: string; provider: string; model: string; units: string; amount: string }>(
			"SELECT source_ref, kind, provider, model, units, amount FROM costs ORDER BY source_ref",
		),
	);
	const ref = `cmd/${h.accountId}-c1/model/r-2-0`;
	assert.deepEqual(
		rows.map((row) => ({ ...row, units: Number(row.units), amount: Number(row.amount) })),
		[
			{
				source_ref: `${ref}/input`,
				kind: "large model",
				provider: "openai",
				model: "gpt-6.2-sol",
				units: 1000,
				amount: 2000,
			},
			{
				source_ref: `${ref}/output`,
				kind: "large model",
				provider: "openai",
				model: "gpt-6.2-sol",
				units: 200,
				amount: 2000,
			},
		],
	);
});

// Each part of the key with 6 characters. No text may have one of them.
const keyParts = (key: string) => Array.from({ length: key.length - 5 }, (_, start) => key.slice(start, start + 6));

test("N3: the provider refuses the key and repeats it; the error, the logs, the messages and the trail have no part of it", async () => {
	const key = "sk-live-n3-0123456789abcdefghijklmnop";
	const fetch: typeof globalThis.fetch = async () =>
		Response.json({ error: { message: `Incorrect API key provided: ${key}` } }, { status: 401 });
	const system = await startSystem([
		piModel({
			provider: "openai",
			model: "gpt-6.2-sol",
			secret: (name) => (name === "OPENAI_API_KEY" ? key : undefined),
			fetch,
		}),
	]);
	const h = await harness("n3");
	const { core, tools } = h.build();
	const lines: string[] = [];
	const commandId = `${h.accountId}-k1`;
	await core.accept(
		{ type: "OwnerMessage", commandId, at: h.now(), messageId: "k1", channel: "chat", text: "Hello" },
		"owner",
	);
	const complete = completion(system.port(ports.petraModel), { log: (line) => lines.push(line), costs: h.costs });
	const answer = await complete({ messages: owner(commandId, "Hello") });
	const call = answer.toolCalls[0];
	assert.ok(call);
	await runTool(tools, call.name, call.input as Record<string, unknown>);
	assert.equal(lines.length, 2);
	assert.match(lines[0] ?? "", /The HTTP status is 401\./);
	const stored = await h.database.transaction({ role: "petra", accountId: h.accountId }, async (tx) => ({
		messages: await tx.query("SELECT body FROM messages"),
		trail: await tx.query("SELECT summary, data FROM trail"),
		costs: await tx.query("SELECT * FROM costs"),
		decisions: await tx.query("SELECT * FROM decisions"),
	}));
	const text = `${lines.join("\n")}\n${JSON.stringify(stored)}`;
	for (const part of keyParts(key)) assert.ok(!text.includes(part), `a text has the part "${part}" of the key`);
});

test("N6: the model reads the memory, then answers with plain text; the owner gets the text, and the event is done", async () => {
	const h = await harness("n6mem");
	const { core, tools } = h.build();
	const commandId = `${h.accountId}-r1`;
	await core.accept(
		{ type: "OwnerMessage", commandId, at: h.now(), messageId: "r1", channel: "chat", text: "What do you know?" },
		"owner",
	);
	const messages = [...owner(commandId, "What do you know?"), toolResult("read_memory")];
	const answer = await completion(fakeModel([answerOf("I know nothing yet.")], []))({ messages });
	const call = answer.toolCalls[0];
	assert.equal(call?.name, "answer_owner");
	assert.ok(call);
	await runTool(tools, call.name, call.input as Record<string, unknown>);
	const replies = (await h.writer.ownerMessagesAfter(0)).filter((message) => message.type === "reply");
	assert.deepEqual(
		replies.map((message) => message.type === "reply" && message.text),
		["I know nothing yet."],
	);
	const rows = await h.database.transaction({ role: "petra", accountId: h.accountId }, (tx) =>
		tx.query<{ status: string }>("SELECT status FROM events WHERE command_id = $1", [commandId]),
	);
	assert.equal(rows[0]?.status, "done");
});

test("N6: a tool fails, then both model calls fail; the owner gets the fixed message", async () => {
	const messages = [...owner("c-9", "Start a task"), toolResult("start_task", true)];
	const answer = await completion(fakeModel(["fail", "fail"], []))({ messages });
	assert.deepEqual(answer.toolCalls, [
		{
			id: "c-9/model-failed",
			name: "answer_owner",
			input: { commandId: "c-9", channel: "chat", text: MODEL_FAILED_TEXT.en },
		},
	]);
});

test("N6: answer_owner or ask_owner with no text sends the fixed message, and never the text of the owner", async () => {
	for (const input of [{}, { text: "" }, { text: "  " }]) {
		const call = { id: "z", name: "ask_owner", input };
		const answer = await completion(fakeModel([answerOf("", [call])], []))({
			messages: owner("c-10", "secret plan"),
		});
		assert.deepEqual(answer.toolCalls[0]?.input, { commandId: "c-10", channel: "chat", text: MODEL_FAILED_TEXT.en });
	}
});

test("N5: in a turn with no command, the tool calls of the model are dropped, so the model never sets a command", async () => {
	const call = { id: "h", name: "start_task", input: { commandId: "c-forged", channel: "email", text: "refund 99" } };
	const history: ModelMessage[] = [{ role: "user", content: "The earlier messages of the owner:\n- Hello" }];
	const answer = await completion(fakeModel([answerOf("Noted.", [call])], []))({ messages: history });
	assert.deepEqual(answer.toolCalls, []);
	assert.equal(answer.text, "Noted.");
});

test("N4: a turn with no command writes its cost rows with the cause history", async () => {
	const h = await harness("n4hist");
	const history: ModelMessage[] = [{ role: "user", content: "The earlier messages of the owner:\n- Hello" }];
	await completion(fakeModel([answerOf("Noted.")], []), { costs: h.costs })({ messages: history });
	const rows = await h.database.transaction({ role: "petra", accountId: h.accountId }, (tx) =>
		tx.query<{ source_ref: string; provider: string }>("SELECT source_ref, provider FROM costs ORDER BY source_ref"),
	);
	assert.deepEqual(
		rows.map((row) => row.source_ref),
		["history/model/r-6-0/input", "history/model/r-6-0/output"],
	);
});

test("N6 and N4: a failed cost write does not cause a second paid model call", async () => {
	const seen: ModelRequest[] = [];
	const costs = {
		modelCall: async () => {
			throw new Error("The database did not answer.");
		},
	};
	await assert.rejects(
		completion(fakeModel([answerOf("Hi"), answerOf("Hi again")], seen), { costs })({ messages: owner("c-11", "Hi") }),
		/The database did not answer/,
	);
	assert.equal(seen.length, 1);
});

test("N9: the fixed texts of the tools are in Arabic for an Arabic message, and in English for an English message", async () => {
	const h = await harness("n9-fixed");
	const { tools } = h.build();
	const u = (id: string) => `${h.accountId}-${id}`;
	await runTool(tools, PETRA_TOOLS.taskStatus, { commandId: u("s-ar"), text: "ما حالة مهمتي؟" });
	await runTool(tools, PETRA_TOOLS.taskStatus, { commandId: u("s-en"), text: "What is the status of my task?" });
	await runTool(tools, PETRA_TOOLS.startTask, { commandId: u("t-ar"), text: "اقرأ ملفين من فضلك" });
	const replies = h.sent.flatMap((m) => (m.type === "reply" ? [m.text] : []));
	assert.equal(replies[0], "ليس لديك مهمة مفتوحة.");
	assert.equal(replies[1], "You have no open task.");
	assert.equal(replies[2], `بدأت المهمة ${u("t-ar")}.`);
});

test("N4: after the tool of the command ran, Petra ends her turn with no model call and no cost row", async () => {
	const seen: ModelRequest[] = [];
	const rows: unknown[] = [];
	const lines: string[] = [];
	const costs = { modelCall: async (...row: unknown[]) => void rows.push(row) };
	const complete = completion(fakeModel([answerOf("Done.")], seen), { costs, log: (line) => lines.push(line) });
	const answer = await complete({ messages: [...owner("c-5", "Hello"), toolResult("answer_owner")] });
	assert.deepEqual(answer.toolCalls, []);
	assert.equal(seen.length, 0);
	assert.equal(rows.length, 0);
	// The runner of evals reads this line to know that the turn of Petra ended.
	assert.ok(lines.includes("petra: turn ended c-5"));
	// A tool that only reads, or a tool that failed, still gets the next model call.
	await complete({ messages: [...owner("c-6", "What do you know?"), toolResult("read_memory")] });
	assert.equal(seen.length, 1);
});
