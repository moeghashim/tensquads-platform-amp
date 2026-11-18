// The gate against a real Postgres (docs/ARCHITECTURE.md, section 4.4, requirements G2 to G10).
// The test is here because a plug-in package must not import another plug-in (requirement C2).

import assert from "node:assert/strict";
import test from "node:test";
import type { TaskResult } from "@tensquads/contracts";

import { checkActionCommandId, contentHash, type GateStore } from "@tensquads/gate";

import { actionRow, gateSetup, reasonOf, refund, statusOf, TOOL_LIMIT_MS, untilSent } from "./gate-harness.js";
import { AT } from "./task-harness.js";

const LIMIT_20 = { kind: "money_limit", params: { maxAmount: 20_000_000 } };
const later = (ms: number) => new Date(Date.parse(AT) + ms).toISOString();

const setRule = (commandId: string, rule = LIMIT_20) => ({ type: "SetRule" as const, commandId, at: AT, rule });

function decision(commandId: string, approvalId: string, hash: string, choice: "approve" | "reject") {
	return { type: "ApprovalDecision" as const, commandId, at: AT, approvalId, decision: choice, contentHash: hash };
}

test("G2: a refund of $15 inside a limit of $20 goes out with no approval", async () => {
	const s = await gateSetup("g2", "refund 15 to cust-1");
	await s.work.setRule(setRule(`${s.taskId}-rule`));
	const answer = await s.action({ content: refund(15) });
	assert.deepEqual(answer, { status: "done", answer: { outcome: "confirmed", actionId: `${s.taskId}/call-1` } });
	assert.equal(s.paid.length, 1);
	assert.deepEqual(await s.messages("approval_request"), []);
	// $25 is above the limit: it needs the approval of the owner.
	assert.deepEqual(await s.action({ toolCallId: "call-2", content: refund(25) }), { status: "wait" });
	assert.equal(s.paid.length, 1);
	const [request] = await s.messages("approval_request");
	assert.equal(request?.type === "approval_request" && request.limit, 20_000_000);
});

test("G2: the newest active money_limit rule wins, and a money action with no rule needs an approval", async () => {
	const s = await gateSetup("g2b", "refund 15 to cust-1");
	assert.deepEqual(await s.action({ content: refund(15) }), { status: "wait" });
	await s.work.setRule(setRule(`${s.taskId}-rule-1`));
	s.h.setNow(later(1000));
	await s.work.setRule({
		...setRule(`${s.taskId}-rule-2`, { kind: "money_limit", params: { maxAmount: 10_000_000 } }),
		at: later(1000),
	});
	assert.deepEqual(await s.action({ toolCallId: "call-2", content: refund(15) }), { status: "wait" });
	assert.equal(s.paid.length, 0);
});

test("G3: a public action always needs the approval of the owner, also with a money limit", async () => {
	const s = await gateSetup("g3", "reply hello to cust-1");
	await s.work.setRule(setRule(`${s.taskId}-rule`));
	const content = { to: "cust-1", text: "hello" };
	assert.deepEqual(await s.action({ tool: "send_reply", content }), { status: "wait" });
	assert.equal(s.sent.length, 0);
	const [request] = await s.messages("approval_request");
	assert.deepEqual(request && { ...request, seq: 0, at: "" }, {
		seq: 0,
		at: "",
		type: "approval_request",
		approvalId: `${s.taskId}/call-1`,
		action: "send_reply",
		content: 'send_reply {"text":"hello","to":"cust-1"}',
		contentHash: await contentHash("send_reply", content),
		rule: null,
		limit: null,
	});
	assert.equal((await s.h.tasks.task(s.taskId))?.status, "waiting for the owner");
	assert.equal((await actionRow(s))?.status, "pending");
});

test("G4: an approval belongs to one content; a wrong hash changes nothing, and a new content needs a new approval", async () => {
	const s = await gateSetup("g4", "refund 25 to cust-1");
	assert.deepEqual(await s.action({ content: refund(25) }), { status: "wait" });
	const approvalId = `${s.taskId}/call-1`;
	const wrong = await contentHash("refund", refund(26));
	await s.work.approvalDecision(decision(`${s.taskId}-d1`, approvalId, wrong, "approve"));
	assert.equal(
		(await s.h.actions.approval(s.taskId, "call-1", await contentHash("refund", refund(25))))?.status,
		"pending",
	);
	assert.equal((await s.h.tasks.attempts(s.taskId)).length, 1);
	assert.equal((await s.messages("status")).length, 1);
	await s.work.approvalDecision(
		decision(`${s.taskId}-d2`, approvalId, await contentHash("refund", refund(25)), "approve"),
	);
	const attemptNo = await s.nextAttempt(`${s.taskId}-d2`);
	// Another tool call with a changed content does not use the approval of the first one.
	assert.deepEqual(await s.action({ attemptNo, toolCallId: "call-2", content: refund(26) }), { status: "wait" });
	assert.deepEqual(await s.action({ attemptNo, content: refund(25) }), {
		status: "done",
		answer: { outcome: "confirmed", actionId: approvalId },
	});
	assert.deepEqual(
		s.paid.map((order) => order.amount),
		[25],
	);
});

test("G6: the gate writes started before the service call, puts a check job in the queue, and writes done after it", async () => {
	const s = await gateSetup("g6", "refund 15 to cust-1", { hold: true });
	await s.work.setRule(setRule(`${s.taskId}-rule`));
	const pending = s.action({ content: refund(15) });
	await untilSent(s.paid);
	const during = await actionRow(s);
	assert.equal(during?.status, "started");
	assert.equal(during?.startedAt, AT);
	assert.equal(s.paid.length, 1);
	const job = s.h.jobs.find((item) => item.body.command.type === "RunJob" && item.body.command.job === "check action");
	assert.equal(job?.delaySeconds, TOOL_LIMIT_MS / 1000);
	assert.equal(job?.body.command.commandId, checkActionCommandId(`${s.taskId}/call-1`, 1, 1));
	s.release();
	assert.equal(statusOf(await pending), "done");
	assert.equal((await actionRow(s))?.status, "done");
});

test("G7: an id that comes again with done gives the saved answer, and the action does not run again", async () => {
	const s = await gateSetup("g7", "refund 15 to cust-1");
	await s.work.setRule(setRule(`${s.taskId}-rule`));
	const first = await s.action({ content: refund(15) });
	s.restart();
	assert.deepEqual(await s.action({ content: refund(15) }), first);
	assert.deepEqual(await s.action({ attemptNo: 2, content: refund(15) }), first);
	assert.equal(s.paid.length, 1);
});

test("G8: an id that comes again with a different content is refused with a trail row, and no second send goes out", async () => {
	const s = await gateSetup("g8", "refund 40 then 45 after a restart");
	await s.work.setRule(setRule(`${s.taskId}-rule`, { kind: "money_limit", params: { maxAmount: 50_000_000 } }));
	assert.equal(statusOf(await s.action({ content: refund(40) })), "done");
	const answer = await s.action({ attemptNo: 2, content: refund(45) });
	assert.equal(statusOf(answer), "refused");
	assert.equal(s.paid.length, 1);
	assert.equal((await actionRow(s))?.status, "done");
	const rows = await s.h.database.transaction({ role: "petra", accountId: s.h.accountId }, (tx) =>
		tx.query<{ kind: string; attempt_no: number }>(
			"SELECT kind, attempt_no FROM trail WHERE task_id = $1 AND kind = 'refusal'",
			[s.taskId],
		),
	);
	assert.deepEqual(rows, [{ kind: "refusal", attempt_no: 2 }]);
});

test("G9: a copy of an action call while the payment waits gets busy; the action gets done and never not_confirmed", async () => {
	const s = await gateSetup("g9a", "refund 15 to cust-1", { hold: true });
	await s.work.setRule(setRule(`${s.taskId}-rule`));
	const first = s.action({ content: refund(15) });
	await untilSent(s.paid);
	assert.deepEqual(await s.action({ content: refund(15) }), { busy: true });
	// The check job comes while the call still runs. It does not ask the service and changes nothing.
	s.h.setNow(later(TOOL_LIMIT_MS + 1000));
	await s.gate.checkJob(checkActionCommandId(`${s.taskId}/call-1`, 1, 1), `${s.taskId}/call-1`);
	assert.equal((await actionRow(s))?.status, "started");
	s.release();
	assert.equal(statusOf(await first), "done");
	await s.gate.checkJob(checkActionCommandId(`${s.taskId}/call-1`, 1, 2), `${s.taskId}/call-1`);
	assert.equal((await actionRow(s))?.status, "done");
	assert.equal(s.paid.length, 1);
	assert.deepEqual(await s.messages("action_not_confirmed"), []);
});

test("G9: a call from a new attempt while the call of the old attempt still runs in Petra gets busy", async () => {
	const s = await gateSetup("g9b", "refund 15 to cust-1", { hold: true });
	await s.work.setRule(setRule(`${s.taskId}-rule`));
	const old = s.gw.call(s.h.claims(s.taskId, 1), {
		call: "action",
		callNo: 2,
		runnerId: "runner-1",
		toolCallId: "call-1",
		tool: "refund",
		content: refund(15),
	});
	await untilSent(s.paid);
	await s.h.tasks.addAttempt({ taskId: s.taskId, causeRef: "fail/2", reason: "after a failure", versions: {} });
	await s.nextAttempt("fail/2");
	const fresh = await s.gw.call(s.h.claims(s.taskId, 2), {
		call: "action",
		callNo: 2,
		runnerId: "runner-2",
		toolCallId: "call-1",
		tool: "refund",
		content: refund(15),
	});
	assert.deepEqual(fresh, { busy: true });
	s.release();
	assert.equal(((await old) as { status: string }).status, "done");
	// "busy" is not saved: the same call number of the new attempt now gets the saved answer of the action.
	const again = await s.gw.call(s.h.claims(s.taskId, 2), {
		call: "action",
		callNo: 2,
		runnerId: "runner-2",
		toolCallId: "call-1",
		tool: "refund",
		content: refund(15),
	});
	assert.equal((again as { status: string }).status, "done");
	assert.equal(s.paid.length, 1);
});

test("G9: a service that cannot confirm gives not_confirmed, no repeat, and Petra sends action_not_confirmed", async () => {
	const s = await gateSetup("g9c", "refund 15 to cust-1", { answer: "unknown" });
	await s.work.setRule(setRule(`${s.taskId}-rule`));
	const answer = await s.action({ content: refund(15) });
	assert.equal(statusOf(answer), "refused");
	assert.match(reasonOf(answer), /cannot confirm/);
	assert.equal((await actionRow(s))?.status, "not_confirmed");
	s.restart();
	assert.deepEqual(await s.action({ attemptNo: 2, content: refund(15) }), answer);
	assert.equal(s.paid.length, 1);
	const messages = await s.messages("action_not_confirmed");
	assert.equal(messages.length, 1);
	assert.equal(messages[0]?.type === "action_not_confirmed" && messages[0].actionId, `${s.taskId}/call-1`);
});

test("G10: a rejected approval gives the status rejected, a refusal to the model, and no send", async () => {
	const s = await gateSetup("g10", "refund 25 to cust-1");
	assert.deepEqual(await s.action({ content: refund(25) }), { status: "wait" });
	const hash = await contentHash("refund", refund(25));
	await s.work.approvalDecision(decision(`${s.taskId}-d`, `${s.taskId}/call-1`, hash, "reject"));
	assert.equal((await actionRow(s))?.status, "rejected");
	assert.equal((await s.h.tasks.task(s.taskId))?.status, "running");
	const attempts = await s.h.tasks.attempts(s.taskId);
	assert.deepEqual(
		attempts.map((item) => [item.reason, item.causeRef]),
		[
			["first", s.taskId],
			["after an approval", `${s.taskId}-d`],
		],
	);
	const attemptNo = await s.nextAttempt(`${s.taskId}-d`);
	const start = await s.gw.call(s.h.claims(s.taskId, attemptNo), {
		call: "start",
		callNo: 1,
		runnerId: `runner-${attemptNo}`,
		runnerCommit: "runner-def",
		pluginListHash: "plugins-123",
	});
	assert.deepEqual("signals" in start && start.signals, [{ key: "call-1", value: { decision: "reject" } }]);
	const answer = await s.action({ attemptNo, content: refund(25) });
	assert.equal(statusOf(answer), "refused");
	assert.match(reasonOf(answer), /rejected/);
	assert.equal(s.paid.length, 0);
});

test("G10: an approved action goes out one time, on the next call with the same id and hash", async () => {
	const s = await gateSetup("g10b", "refund 25 to cust-1");
	assert.deepEqual(await s.action({ content: refund(25) }), { status: "wait" });
	const hash = await contentHash("refund", refund(25));
	await s.work.approvalDecision(decision(`${s.taskId}-d`, `${s.taskId}/call-1`, hash, "approve"));
	// The same command again changes nothing (section 9).
	await s.work.approvalDecision(decision(`${s.taskId}-d`, `${s.taskId}/call-1`, hash, "approve"));
	const attemptNo = await s.nextAttempt(`${s.taskId}-d`);
	const inbox = await s.gw.call(s.h.claims(s.taskId, attemptNo), {
		call: "inbox",
		callNo: 2,
		runnerId: `runner-${attemptNo}`,
	});
	assert.deepEqual("signals" in inbox && inbox.signals, [{ key: "call-1", value: { decision: "approve" } }]);
	assert.equal(statusOf(await s.action({ attemptNo, content: refund(25) })), "done");
	assert.equal(statusOf(await s.action({ attemptNo, content: refund(25) })), "done");
	assert.equal(s.paid.length, 1);
	assert.equal((await s.messages("approval_request")).length, 1);
	assert.equal((await s.h.tasks.attempts(s.taskId)).length, 2);
});

test("G4: Petra stops after the pending action and before the request; the owner gets the request one time", async () => {
	const s = await gateSetup("pend", "refund 25 to cust-1");
	let stops = 1;
	const stopping: GateStore = {
		...s.h.actions,
		addApproval: async (row) => {
			if (stops-- > 0) throw new Error("Petra stops.");
			await s.h.actions.addApproval(row);
		},
	};
	s.restart(stopping);
	await assert.rejects(s.action({ content: refund(25) }), /Petra stops/);
	assert.equal((await actionRow(s))?.status, "pending");
	assert.deepEqual(await s.messages("approval_request"), []);
	assert.deepEqual(await s.action({ content: refund(25) }), { status: "wait" });
	assert.deepEqual(await s.action({ attemptNo: 1, content: refund(25) }), { status: "wait" });
	assert.equal((await s.messages("approval_request")).length, 1);
	assert.equal((await s.h.tasks.task(s.taskId))?.status, "waiting for the owner");
	assert.equal(s.paid.length, 0);
});

test("G10: an ApprovalDecision for a task that was cancelled sends no action, and the owner gets a status message", async () => {
	const s = await gateSetup("cancel", "refund 25 to cust-1");
	assert.deepEqual(await s.action({ content: refund(25) }), { status: "wait" });
	await s.work.cancel(s.taskId);
	const hash = await contentHash("refund", refund(25));
	await s.work.approvalDecision(decision(`${s.taskId}-d`, `${s.taskId}/call-1`, hash, "approve"));
	assert.equal((await s.h.actions.approval(s.taskId, "call-1", hash))?.status, "pending");
	assert.equal((await s.h.tasks.attempts(s.taskId)).length, 1);
	assert.equal((await s.h.tasks.task(s.taskId))?.status, "cancelled");
	const [status] = await s.messages("status");
	assert.match(status?.type === "status" ? status.step : "", /cancelled/);
	assert.equal(s.paid.length, 0);
	assert.equal(s.h.list.size, 1);
});

test("G12: Petra stops between started and done; the service status decides, and the action goes out one time", async () => {
	const s = await gateSetup("g12", "refund 15 to cust-1", { hold: true });
	await s.work.setRule(setRule(`${s.taskId}-rule`));
	// The first call never ends: Petra stopped during the service call.
	void s.action({ content: refund(15) });
	await untilSent(s.paid);
	s.restart();
	// The copy of the call finds "started" and no mark. The service has the send, so the action is done.
	const answer = await s.action({ content: refund(15) });
	assert.deepEqual(answer, { status: "done", answer: { outcome: "confirmed", actionId: `${s.taskId}/call-1` } });
	assert.equal(s.paid.length, 1);
	s.release();
});

test("G12: Petra stops after started and before the service got it; the copy of the call sends it one time", async () => {
	const s = await gateSetup("g12b", "refund 15 to cust-1");
	await s.work.setRule(setRule(`${s.taskId}-rule`));
	const hash = await contentHash("refund", refund(15));
	await s.h.actions.addAction({
		taskId: s.taskId,
		toolCallId: "call-1",
		attemptNo: 1,
		tool: "refund",
		kind: "money",
		content: refund(15),
		contentHash: hash,
		status: "started",
		startedAt: AT,
	});
	assert.equal(statusOf(await s.action({ content: refund(15) })), "done");
	assert.equal(statusOf(await s.action({ content: refund(15) })), "done");
	assert.equal(s.paid.length, 1);
});

test("G9: the check action job waits for the tool limit, then sets not_confirmed and tells the owner", async () => {
	const s = await gateSetup("check", "refund 15 to cust-1", { hold: true, answer: "unknown" });
	await s.work.setRule(setRule(`${s.taskId}-rule`));
	void s.action({ content: refund(15) });
	await untilSent(s.paid);
	s.restart();
	const actionId = `${s.taskId}/call-1`;
	const jobs = s.h.jobs.length;
	// Before the tool limit the job only puts the next check in the queue.
	await s.work.checkAction(checkActionCommandId(actionId, 1, 1), actionId);
	assert.equal((await actionRow(s))?.status, "started");
	assert.equal(s.h.jobs.length, jobs + 1);
	s.h.setNow(later(TOOL_LIMIT_MS + 1));
	await s.work.checkAction(checkActionCommandId(actionId, 1, 2), actionId);
	assert.equal((await actionRow(s))?.status, "not_confirmed");
	assert.equal((await s.messages("action_not_confirmed")).length, 1);
	// A second job changes nothing.
	await s.work.checkAction(checkActionCommandId(actionId, 1, 3), actionId);
	assert.equal((await s.messages("action_not_confirmed")).length, 1);
	assert.equal(s.paid.length, 1);
	s.release();
});

test("G10: the owner decides before the task waits; when the runner parks, a new attempt starts one time", async () => {
	const s = await gateSetup("race", "refund 25 to cust-1");
	assert.deepEqual(await s.action({ content: refund(25) }), { status: "wait" });
	// The decision comes in the moment before the gate set "waiting for the owner".
	await s.h.tasks.setTaskStatus({ taskId: s.taskId, status: "running", at: "2026-11-18T10:00:01.000Z" });
	const hash = await contentHash("refund", refund(25));
	await s.work.approvalDecision(decision(`${s.taskId}-d`, `${s.taskId}/call-1`, hash, "approve"));
	assert.equal((await s.h.tasks.attempts(s.taskId)).length, 1);
	await s.h.tasks.setTaskStatus({ taskId: s.taskId, status: "waiting for the owner", at: "2026-11-18T10:00:02.000Z" });
	const parked: TaskResult = { stop: "waiting", answer: "", evidence: [], proposedFacts: [], notes: [] };
	for (const callNo of [3, 4]) {
		await s.gw.call(s.h.claims(s.taskId, 1), { call: "result", callNo, runnerId: "runner-1", result: parked });
	}
	const attempts = await s.h.tasks.attempts(s.taskId);
	assert.deepEqual(
		attempts.map((attempt) => [attempt.attemptNo, attempt.reason, attempt.causeRef]),
		[
			[1, "first", s.taskId],
			[2, "after an approval", `${s.taskId}-d`],
		],
	);
	assert.equal((await s.h.tasks.task(s.taskId))?.status, "running");
});
