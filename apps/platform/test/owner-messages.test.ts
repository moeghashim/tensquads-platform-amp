// The two messages of task 12 for a screen: the decision on an approval and the answer to a question.
// Petra writes each message only when the command changed something, with the stored decision.
import assert from "node:assert/strict";
import test from "node:test";

import type { Command, OwnerMessage } from "@tensquads/contracts";
import { contentHash } from "@tensquads/gate";
import { PETRA_TOOLS } from "@tensquads/petra";

import { gateSetup, refund } from "./gate-harness.js";
import { AT, type Harness, harness, runTool, startRunner } from "./task-harness.js";

function decision(commandId: string, approvalId: string, hash: string, choice: "approve" | "reject"): Command {
	return { type: "ApprovalDecision", commandId, at: AT, approvalId, decision: choice, contentHash: hash };
}

async function messagesOf(h: Harness, type: OwnerMessage["type"]) {
	const all = await h.writer.ownerMessagesAfter(0);
	return all.filter((message) => message.type === type).map(({ seq: _seq, at: _at, ...message }) => message);
}

// The channel of each message of one type, from the database.
async function channelsOf(h: Harness, type: OwnerMessage["type"]): Promise<string[]> {
	const rows = await h.database.transaction({ role: "petra", accountId: h.accountId }, (tx) =>
		tx.query<{ channel: string }>("SELECT channel FROM messages WHERE type = $1 ORDER BY seq", [type]),
	);
	return rows.map((row) => row.channel);
}

test("O1: Petra writes approval_decided when she handles an ApprovalDecision, one time for one command", async () => {
	const s = await gateSetup("o1d", "refund 25 to cust-1");
	assert.deepEqual(await s.action({ content: refund(25) }), { status: "wait" });
	const hash = await contentHash("refund", refund(25));
	const command = decision(`${s.taskId}-d1`, `${s.taskId}/call-1`, hash, "reject");
	await s.core.accept(command, "owner");
	await s.core.work();
	await s.core.accept(command, "owner");
	await s.core.work();
	assert.deepEqual(await messagesOf(s.h, "approval_decided"), [
		{ type: "approval_decided", approvalId: `${s.taskId}/call-1`, decision: "reject" },
	]);
});

test("O1: a second ApprovalDecision with the other decision gives no second approval_decided", async () => {
	const s = await gateSetup("o1d2", "refund 25 to cust-1");
	assert.deepEqual(await s.action({ content: refund(25) }), { status: "wait" });
	const hash = await contentHash("refund", refund(25));
	await s.core.accept(decision(`${s.taskId}-d1`, `${s.taskId}/call-1`, hash, "approve"), "owner");
	await s.core.work();
	await s.core.accept(decision(`${s.taskId}-d2`, `${s.taskId}/call-1`, hash, "reject"), "owner");
	await s.core.work();
	assert.deepEqual(await messagesOf(s.h, "approval_decided"), [
		{ type: "approval_decided", approvalId: `${s.taskId}/call-1`, decision: "approve" },
	]);
});

test("O1: an ApprovalDecision for an unknown approvalId gives no approval_decided", async () => {
	const h = await harness("o1du");
	const { core } = h.build();
	await core.accept(decision(`${h.accountId}-d1`, "task-x/call-1", "sha256:abc", "reject"), "owner");
	await core.work();
	assert.deepEqual(await messagesOf(h, "approval_decided"), []);
});

test("O1: Petra writes question_answered on the channel of the task when she applies an OwnerAnswer", async () => {
	const h = await harness("o1q");
	const { core, tools, work } = h.build();
	const taskId = `${h.accountId}-t1`;
	await runTool(tools, PETRA_TOOLS.startTask, { commandId: taskId, text: "Answer.", channel: "web" });
	await startRunner(h, taskId, 1);
	const question = { id: `${h.accountId}-q1`, text: "Which shop?" };
	await work.afterResult(h.claims(taskId, 1), {
		stop: "question",
		answer: "",
		evidence: [],
		proposedFacts: [],
		notes: [],
		question,
	});
	await core.accept(
		{ type: "OwnerAnswer", commandId: `${h.accountId}-a1`, at: AT, questionId: question.id, text: "Riyadh" },
		"owner",
	);
	await core.work();
	assert.deepEqual(await messagesOf(h, "question_answered"), [{ type: "question_answered", questionId: question.id }]);
	assert.deepEqual(await channelsOf(h, "question_answered"), ["web"]);
});

test("O1: an OwnerAnswer that was not applied gives no question_answered", async () => {
	const h = await harness("o1qn");
	const { core } = h.build();
	await core.accept(
		{ type: "OwnerAnswer", commandId: `${h.accountId}-a1`, at: AT, questionId: "cmd-1/ask", text: "Tuesday" },
		"owner",
	);
	await core.work();
	assert.deepEqual(await messagesOf(h, "question_answered"), []);
});
