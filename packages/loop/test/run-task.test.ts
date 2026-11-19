import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { taskResult } from "@tensquads/contracts";
import { type Model, type Plugin, type PortKey, ports, type System, startSystem } from "@tensquads/core";

import { journalCopy } from "../src/journal.js";
import { type ModelCall, RefusedError } from "../src/link.js";
import { runTask } from "../src/run-task.js";
import { QUESTION_TOOL, type ToolExecute } from "../src/tools.js";
import { FakeLink, taskOptions as options, type Script, text, toolCall, toolMessages, workDir } from "./fake-link.js";

const TIMEOUT = { timeout: 30_000 };

async function emptySystem(): Promise<System> {
	return startSystem([]);
}

function userTexts(call: ModelCall): string[] {
	return call.messages.filter((m) => m.role === "user").map((m) => m.content);
}

test("L1: the first model request has the brief and no earlier context", TIMEOUT, async (t) => {
	const link = new FakeLink(() => text("The shop opens at 9."));
	await runTask(options(link, workDir(t), await emptySystem()));
	const first = link.models[0];
	assert.ok(first);
	assert.equal(first.turnNo, 1);
	const context = first.messages.filter((m) => m.role !== "system");
	assert.equal(context.length, 1);
	assert.equal(context[0]?.role, "user");
	const content = context[0]?.content ?? "";
	for (const part of [
		"Goal: Answer",
		"Done: The customer",
		"[fact-1] The shop opens at 9.",
		"Limits:",
		"Refunds.",
		"Reply to: owner-1",
	]) {
		assert.ok(content.includes(part), `The brief has "${part}".`);
	}
});

test("L2: a task stops with success when the answer stands", TIMEOUT, async (t) => {
	const link = new FakeLink((call) => text(call.turnNo === 1 ? "first answer" : "better answer"));
	link.verdicts = [{ verdict: "continue", reason: "Say more." }];
	const result = await runTask(options(link, workDir(t), await emptySystem()));
	assert.equal(result.stop, "success");
	assert.equal(result.answer, "better answer");
	assert.equal(link.results.length, 2);
	// The reason of "continue" goes back to the model.
	assert.ok(userTexts(link.models[1] as ModelCall).includes("Say more."));
	taskResult.parse(result);
});

test("L2: a task stops with question, max_turns and error", TIMEOUT, async (t) => {
	const system = await emptySystem();
	const question = await runTask(
		options(new FakeLink(() => toolCall("q-1", QUESTION_TOOL, { text: "Which day?" })), workDir(t), system),
	);
	assert.equal(question.stop, "question");
	assert.deepEqual(question.question, { id: "q-1", text: "Which day?" });

	const limit = await runTask(options(new FakeLink(() => ({ limit: "max_turns" })), workDir(t), system));
	assert.equal(limit.stop, "max_turns");

	const broken = new FakeLink(() => {
		throw new Error("The connection broke.");
	});
	const error = await runTask(options(broken, workDir(t), system));
	assert.equal(error.stop, "error");
	assert.match(error.answer, /The connection broke/);

	for (const result of [question, limit, error]) {
		taskResult.parse(result);
	}
});

test("L2: a refusal of the gateway ends the runner with RefusedError", TIMEOUT, async (t) => {
	const link = new FakeLink(() => {
		throw new RefusedError("pass", "model");
	});
	await assert.rejects(runTask(options(link, workDir(t), await emptySystem())), RefusedError);
});

test("L3: an inbox message reaches the model one time, also after a resume from a copy", TIMEOUT, async (t) => {
	const message = { sourceRef: "msg-1", text: "Use the new opening time." };
	const seen = (call: ModelCall) => userTexts(call).filter((value) => value === message.text).length;
	// Attempt 1: the runner takes the message, the tool round ends, and the sandbox stops at the next model call.
	const first = new FakeLink((call) => {
		if (call.turnNo === 1) return toolCall("c-1", "read_file", { path: "hours.txt" });
		throw new Error("The sandbox stopped.");
	});
	first.inboxAnswer = { messages: [message], forget: [], signals: [] };
	const system = await emptySystem();
	assert.equal((await runTask(options(first, workDir(t), system))).stop, "error");
	assert.equal(first.journals.length, 1);
	assert.equal(seen(first.models[1] as ModelCall), 1);

	// Attempt 2: a new sandbox opens the copy. The inbox gives the same message again.
	const second = new FakeLink(() => text("We open at 10."));
	second.savedCopy = first.savedCopy;
	second.inboxAnswer = first.inboxAnswer;
	const result = await runTask({ ...options(second, workDir(t), system), attemptNo: 2 });
	assert.equal(result.stop, "success");
	assert.ok(second.models.length > 0);
	// The new attempt continues from the copy: the model has the tool result of attempt 1.
	assert.deepEqual(
		toolMessages(second.models[0] as ModelCall).map((m) => m.toolCallId),
		["c-1"],
	);
	for (const call of second.models) {
		assert.equal(seen(call), 1);
	}
	assert.equal(second.inboxCalls, second.models.length);
});

test("L4: at the limit of turns the task stops and no new tool starts", TIMEOUT, async (t) => {
	const ran: string[] = [];
	const link = new FakeLink((call) =>
		call.turnNo >= 3 ? { limit: "max_turns" } : toolCall(`c-${call.turnNo}`, "read_file", { path: "a" }),
	);
	const read: ToolExecute = async () => {
		ran.push("read_file");
		return "a";
	};
	const result = await runTask(options(link, workDir(t), await emptySystem(), { read_file: read }));
	assert.equal(result.stop, "max_turns");
	assert.equal(ran.length, 2);
	assert.deepEqual(
		link.steps.map((step) => step.toolCallId),
		["c-1", "c-2"],
	);
	assert.equal(link.results.length, 0);
});

test("L6: ask_question parks, and the answer comes back as the result of the same tool call", TIMEOUT, async (t) => {
	const script: Script = (call) => {
		const answer = toolMessages(call).find((m) => m.toolCallId === "q-1");
		return answer === undefined
			? toolCall("q-1", QUESTION_TOOL, { text: "Which day?" })
			: text(`On ${answer.output}.`);
	};
	const system = await emptySystem();
	const first = new FakeLink(script);
	const parked = await runTask(options(first, workDir(t), system));
	assert.equal(parked.stop, "question");
	assert.deepEqual(parked.question, { id: "q-1", text: "Which day?" });
	assert.equal(first.journals.length, 1);
	assert.equal(first.models.length, 1);

	// A new attempt in a new sandbox: the copy and the answer as a signal.
	const second = new FakeLink(script);
	second.savedCopy = first.savedCopy;
	second.signals = [{ key: "q-1", value: "Monday" }];
	const result = await runTask({ ...options(second, workDir(t), system), attemptNo: 2 });
	assert.equal(result.stop, "success");
	assert.equal(result.answer, "On Monday.");
	const results = toolMessages(second.models.at(-1) as ModelCall);
	assert.deepEqual(
		results.map((m) => [m.toolCallId, m.tool, m.output]),
		[["q-1", QUESTION_TOOL, "Monday"]],
	);
	// The model did not ask the question a second time.
	assert.equal(second.models.length, 1);
});

test("L8: one changed row replaces the model and one tool, with no change to the loop", TIMEOUT, async (t) => {
	const calculator: PortKey<{ execute: (input: Record<string, unknown>) => Promise<string> }> = {
		name: "tool calculate",
	};
	const modelRow = (answer: string): Plugin => ({
		name: "model",
		provides: [ports.model],
		needs: [],
		apply(ctx) {
			const model: Model = {
				async complete(request) {
					const done = request.messages.some((m) => m.role === "tool");
					return done
						? text(`${answer}: ${request.messages.at(-1)?.content}`)
						: toolCall("c-1", "calculate", { a: 2 });
				},
			};
			ctx.provide(ports.model, model);
		},
	});
	const toolRow = (factor: number): Plugin => ({
		name: "calculate",
		provides: [calculator],
		needs: [],
		apply(ctx) {
			ctx.provide(calculator, { execute: async (input) => String(Number(input.a) * factor) });
		},
	});
	async function run(list: Plugin[]): Promise<string> {
		const system = await startSystem(list);
		// The gateway calls the model port. The runner gets the tool from its row.
		const link = new FakeLink((call) => system.port(ports.model).complete(call));
		const tools = { calculate: (input: Record<string, unknown>) => system.port(calculator).execute(input) };
		const result = await runTask(options(link, workDir(t), system, tools));
		await system.stop();
		return result.answer;
	}
	const before = await run([modelRow("model A"), toolRow(10)]);
	const after = await run([modelRow("model B"), toolRow(100)]);
	assert.match(before, /^model A: .*"output":"20"/);
	assert.match(after, /^model B: .*"output":"200"/);
});

test("L10: each model call goes through link.model", TIMEOUT, async (t) => {
	const link = new FakeLink((call) =>
		call.turnNo <= 2 ? toolCall(`c-${call.turnNo}`, "read_file", { path: "x" }) : text("done"),
	);
	const result = await runTask(options(link, workDir(t), await emptySystem()));
	assert.equal(result.stop, "success");
	assert.deepEqual(
		link.models.map((call) => call.turnNo),
		[1, 2, 3],
	);
	// The model gets the tools that the runner has code for, the question tool and the action tools.
	assert.deepEqual(link.models[0]?.tools.sort(), [QUESTION_TOOL, "read_file", "refund", "send_reply"].sort());
});

test("tool/before refuses a tool that is not in the bot definition", TIMEOUT, async (t) => {
	const link = new FakeLink((call) =>
		call.turnNo === 1 ? toolCall("c-1", "delete_all") : text(toolMessages(call)[0]?.output ?? ""),
	);
	let ran = false;
	// The runner has code for the tool, but the definition of the bot does not list it.
	const deleteAll: ToolExecute = async () => {
		ran = true;
		return "deleted";
	};
	const result = await runTask(options(link, workDir(t), await emptySystem(), { delete_all: deleteAll }));
	assert.equal(result.stop, "success");
	assert.match(result.answer, /not on the list of the bot/);
	assert.equal(ran, false);
	assert.ok(!link.models[0]?.tools.includes("delete_all"));
});

test("the copy sent to journal opens as a valid SQLite file", TIMEOUT, async (t) => {
	const link = new FakeLink((call) => (call.turnNo === 1 ? toolCall("c-1", "read_file", { path: "x" }) : text("ok")));
	const dir = workDir(t);
	await runTask(options(link, dir, await emptySystem()));
	const copy = link.journals[0];
	assert.ok(copy);
	const file = join(dir, "opened.sqlite");
	writeFileSync(file, Buffer.from(copy, "base64"));
	const db = new DatabaseSync(file);
	try {
		assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
		const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number };
		assert.ok(tables.n > 0);
	} finally {
		db.close();
	}
	// journalCopy also works on the file that it gave.
	assert.ok(journalCopy(file).length > 0);
});
