import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type System, startSystem } from "@tensquads/core";

import { FILES_DIR } from "../src/drafts.js";
import type { ModelCall } from "../src/link.js";
import { runTask } from "../src/run-task.js";
import type { ToolExecute } from "../src/tools.js";
import { FakeLink, type Script, taskOptions, text, toolCall, toolMessages, workDir } from "./fake-link.js";

// The action tools, the approvals and the drafts in the loop (requirements G1, G5, G10, G11).

const TIMEOUT = { timeout: 30_000 };
const REFUND = { amount: 40, orderId: "o-1" };

function emptySystem(): Promise<System> {
	return startSystem([]);
}

function base64(value: string): string {
	return Buffer.from(value).toString("base64");
}

// The model asks for one refund. When the tool result is there, it answers with the result as text.
// The counter shows how many times the model asked for the action.
function refundScript(): { script: Script; asked: () => number } {
	let asked = 0;
	const script: Script = (call) => {
		const result = toolMessages(call).find((m) => m.toolCallId === "c-1");
		if (result !== undefined) {
			return text(`${result.isError ? "refused" : "done"}: ${result.output}`);
		}
		asked += 1;
		return toolCall("c-1", "refund", REFUND);
	};
	return { script, asked: () => asked };
}

// The calls of the link after the first model call and before the step of the tool.
function callsOfTool(link: FakeLink): string[] {
	const calls = link.calls;
	return calls.slice(calls.indexOf("model") + 1, calls.indexOf("step"));
}

test(
	"G5: the action tool saves a journal copy before it calls action, and uses the tool-call id",
	TIMEOUT,
	async (t) => {
		const { script } = refundScript();
		const link = new FakeLink(script);
		link.gate = () => ({ status: "done", answer: { refundId: "r-1" } });
		const result = await runTask(taskOptions(link, workDir(t), await emptySystem()));
		assert.equal(result.stop, "success");
		assert.deepEqual(callsOfTool(link), ["journal", "action"]);
		assert.deepEqual(link.actions, [{ toolCallId: "c-1", tool: "refund", content: REFUND }]);
		assert.equal(result.answer, 'done: {"refundId":"r-1"}');
	},
);

test(
	"G5: after a stop during action, the new attempt asks the gate with the same id, and the model does not ask again",
	TIMEOUT,
	async (t) => {
		const { script, asked } = refundScript();
		const system = await emptySystem();
		const first = new FakeLink(script);
		first.gate = () => {
			throw new Error("The sandbox stopped.");
		};
		assert.equal((await runTask(taskOptions(first, workDir(t), system))).stop, "error");
		assert.equal(first.journals.length, 1);

		// The new attempt opens the copy that the action tool saved before its call.
		const second = new FakeLink(script);
		second.savedCopy = first.savedCopy;
		const result = await runTask({ ...taskOptions(second, workDir(t), system), attemptNo: 2 });
		assert.equal(result.stop, "success");
		assert.deepEqual(
			second.actions.map((call) => call.toolCallId),
			["c-1"],
		);
		assert.equal(asked(), 1);
	},
);

test("G1: the action tool calls only link.action, and the bot gives no code for an action tool", TIMEOUT, async (t) => {
	const { script } = refundScript();
	const link = new FakeLink(script);
	const system = await emptySystem();
	await runTask(taskOptions(link, workDir(t), system));
	// Between the model answer and the step, the only calls are the copy and the action.
	assert.deepEqual(callsOfTool(link), ["journal", "action"]);
	assert.ok(link.models[0]?.tools.includes("refund"));

	// A bot that gives code for an action tool does not run.
	let ran = false;
	const refund: ToolExecute = async () => {
		ran = true;
		return "sent by the bot";
	};
	const coded = new FakeLink(script);
	await assert.rejects(
		runTask(taskOptions(coded, workDir(t), system, { refund })),
		/gives code for the action tools refund/,
	);
	assert.equal(ran, false);
	assert.equal(coded.actions.length, 0);
});

test(
	"G5: wait parks, the task stops waiting, and an approve signal gives done to the same tool-call id",
	TIMEOUT,
	async (t) => {
		const { script, asked } = refundScript();
		const system = await emptySystem();
		const first = new FakeLink(script);
		first.gate = () => ({ status: "wait" });
		const parked = await runTask(taskOptions(first, workDir(t), system));
		assert.equal(parked.stop, "waiting");
		assert.equal(parked.question, undefined);
		// A copy before the action, and a copy with the park.
		assert.deepEqual(first.calls.slice(-3), ["journal", "action", "journal"]);
		assert.equal(first.steps.length, 0);
		assert.equal(first.models.length, 1);

		const second = new FakeLink(script);
		second.savedCopy = first.savedCopy;
		second.signals = [{ key: "c-1", value: { decision: "approve" } }];
		second.gate = () => ({ status: "done", answer: { refundId: "r-1" } });
		const result = await runTask({ ...taskOptions(second, workDir(t), system), attemptNo: 2 });
		assert.equal(result.stop, "success");
		assert.equal(result.answer, 'done: {"refundId":"r-1"}');
		// The same id and the same content go to the gate again.
		assert.deepEqual(second.actions, [{ toolCallId: "c-1", tool: "refund", content: REFUND }]);
		// The tool runs again before the first model call of the new attempt.
		assert.deepEqual(second.calls.slice(0, 4), ["start", "journal", "action", "step"]);
		// The model asked for the action one time, and never got "wait".
		assert.equal(asked(), 1);
		const results = toolMessages(second.models.at(-1) as ModelCall);
		assert.deepEqual(
			results.map((m) => [m.toolCallId, m.output, m.isError]),
			[["c-1", '{"refundId":"r-1"}', false]],
		);
	},
);

test("G10: a reject signal gives the model a refusal with the reason, and no done", TIMEOUT, async (t) => {
	const { script, asked } = refundScript();
	const system = await emptySystem();
	const first = new FakeLink(script);
	first.gate = () => ({ status: "wait" });
	assert.equal((await runTask(taskOptions(first, workDir(t), system))).stop, "waiting");

	const second = new FakeLink(script);
	second.savedCopy = first.savedCopy;
	second.signals = [{ key: "c-1", value: { decision: "reject" } }];
	second.gate = () => ({ status: "refused", reason: "The owner rejected the refund." });
	const result = await runTask({ ...taskOptions(second, workDir(t), system), attemptNo: 2 });
	// The refusal goes to the model, and the loop continues to an answer.
	assert.equal(result.stop, "success");
	assert.equal(result.answer, "refused: The owner rejected the refund.");
	const results = toolMessages(second.models.at(-1) as ModelCall);
	assert.deepEqual(
		results.map((m) => [m.toolCallId, m.output, m.isError]),
		[["c-1", "The owner rejected the refund.", true]],
	);
	assert.equal(asked(), 1);
});

// A tool that adds text at the end of a file of the work directory, as append_file of the test bot does.
const append: ToolExecute = async (input, filesDir) => {
	appendFileSync(join(filesDir, String(input.path)), String(input.text));
	return "added";
};

const read: ToolExecute = async (input, filesDir) => readFileSync(join(filesDir, String(input.path)), "utf8");

test("G11: a step that changes a file sends the file to draft, and a read sends nothing", TIMEOUT, async (t) => {
	const link = new FakeLink((call) => {
		if (call.turnNo === 1) return toolCall("c-1", "append_file", { path: "notes.txt", text: "a\n" });
		if (call.turnNo === 2) return toolCall("c-2", "read_file", { path: "notes.txt" });
		return text("ok");
	});
	const tools = { append_file: append, read_file: read };
	const result = await runTask(taskOptions(link, workDir(t), await emptySystem(), tools));
	assert.equal(result.stop, "success");
	assert.deepEqual(link.drafts, [{ path: "notes.txt", body: base64("a\n") }]);
	assert.deepEqual(link.calls.slice(link.calls.indexOf("step"), link.calls.indexOf("step") + 2), ["step", "draft"]);
});

test(
	"G11: a new attempt writes the drafts of start into the work directory before the loop resumes",
	TIMEOUT,
	async (t) => {
		const link = new FakeLink((call) =>
			call.turnNo === 1
				? toolCall("c-1", "read_file", { path: "notes.txt" })
				: text(toolMessages(call)[0]?.output ?? ""),
		);
		link.savedDrafts = [{ path: "notes.txt", body: base64("from the draft\n") }];
		const result = await runTask(taskOptions(link, workDir(t), await emptySystem(), { read_file: read }));
		assert.equal(result.answer, "from the draft\n");
		// A file that did not change is not sent again.
		assert.deepEqual(link.drafts, []);
	},
);

test("G11: after a stop before the copy, the new attempt has the append one time at the end", TIMEOUT, async (t) => {
	const script: Script = (call) => {
		if (call.turnNo === 1) return toolCall("c-1", "append_file", { path: "notes.txt", text: "a\n" });
		if (call.turnNo === 2) return toolCall("c-2", "append_file", { path: "notes.txt", text: "b\n" });
		return text("ok");
	};
	const system = await emptySystem();
	const first = new FakeLink(script);
	// The copy after turn 1 arrives. The sandbox stops before the copy after turn 2.
	first.failJournalAt = 2;
	assert.equal((await runTask(taskOptions(first, workDir(t), system, { append_file: append }))).stop, "error");
	assert.deepEqual(
		first.drafts.map((draft) => draft.body),
		[base64("a\n"), base64("a\nb\n")],
	);
	// The gateway gives the file as it was at the copy.
	assert.deepEqual(first.savedDrafts, [{ path: "notes.txt", body: base64("a\n") }]);

	const second = new FakeLink(script);
	second.savedCopy = first.savedCopy;
	second.savedDrafts = first.savedDrafts;
	const dir = workDir(t);
	const result = await runTask({ ...taskOptions(second, dir, system, { append_file: append }), attemptNo: 2 });
	assert.equal(result.stop, "success");
	// The lost turn runs again one time, so the append is there one time.
	assert.equal(readFileSync(join(dir, FILES_DIR, "notes.txt"), "utf8"), "a\nb\n");
	assert.deepEqual(second.drafts, [{ path: "notes.txt", body: base64("a\nb\n") }]);
	assert.deepEqual(
		second.models.map((call) => call.turnNo),
		[2, 3],
	);
});
