// The draft store and the gateway calls "draft" and "action" (requirements G1, G11, section 3.5).
import assert from "node:assert/strict";
import test from "node:test";

import { PETRA_HANDLES } from "@tensquads/petra";

import { gateSetup, refund, startCall } from "./gate-harness.js";

const draft = (callNo: number, path: string, text: string) => ({
	call: "draft" as const,
	callNo,
	runnerId: "runner-1",
	path,
	body: btoa(text),
});

test("G11: start gives, for each path, the newest draft that is not newer than the journal copy", async () => {
	const s = await gateSetup("g11", "read 1 file");
	const claims = s.h.claims(s.taskId, 1);
	assert.equal("refused" in (await s.gw.call(claims, startCall(1, "runner-1"))), false);
	assert.deepEqual(await s.gw.call(claims, draft(2, "notes.txt", "line 1\n")), { ok: true });
	assert.deepEqual(await s.gw.call(claims, draft(9, "notes.txt", "line 1\nline 2\n")), { ok: true });
	assert.deepEqual(await s.gw.call(claims, draft(8, "other.txt", "x")), { ok: true });
	// The copy has the call number 10. As text, "11" is smaller than "9".
	await s.gw.call(claims, { call: "journal", callNo: 10, runnerId: "runner-1", copy: btoa("copy at 10") });
	// An append after the last copy. Then the runner stops.
	assert.deepEqual(await s.gw.call(claims, draft(11, "notes.txt", "line 1\nline 2\nline 3\n")), { ok: true });
	assert.deepEqual(await s.gw.call(claims, draft(12, "late.txt", "after the copy")), { ok: true });
	// A copy of a draft call gets the saved answer and writes no second row.
	assert.deepEqual(await s.gw.call(claims, draft(11, "notes.txt", "line 1\nline 2\nline 3\n")), { ok: true });

	await s.h.tasks.addAttempt({ taskId: s.taskId, causeRef: "fail/2", reason: "after a failure", versions: {} });
	const start = await s.gw.call(s.h.claims(s.taskId, 2), startCall(1, "runner-2"));
	assert.ok("drafts" in start);
	assert.equal(atob(start.journal ?? ""), "copy at 10");
	assert.deepEqual(
		start.drafts.map((file) => [file.path, atob(file.body)]),
		[
			["notes.txt", "line 1\nline 2\n"],
			["other.txt", "x"],
		],
	);
	const rows = await s.h.database.transaction({ role: "petra", accountId: s.h.accountId }, (tx) =>
		tx.query<{ path: string; attempt_no: number; call_no: number; blob_key: string }>(
			"SELECT path, attempt_no, call_no, blob_key FROM draft_files WHERE task_id = $1 ORDER BY call_no, path",
			[s.taskId],
		),
	);
	assert.equal(rows.length, 5);
	assert.equal(rows.at(-2)?.blob_key, `draft/${s.taskId}/1/11/notes.txt`);
});

test("G1: an action call on the gateway goes to the gate, and a copy of the call number gets the saved answer", async () => {
	const s = await gateSetup("g1gw", "refund 15 to cust-1");
	await s.work.setRule({
		type: "SetRule",
		commandId: `${s.taskId}-rule`,
		at: "2026-11-18T10:00:00.000Z",
		rule: { kind: "money_limit", params: { maxAmount: 20_000_000 } },
	});
	const claims = s.h.claims(s.taskId, 1);
	await s.gw.call(claims, startCall(1, "runner-1"));
	const call = {
		call: "action" as const,
		callNo: 2,
		runnerId: "runner-1",
		toolCallId: "call-1",
		tool: "refund",
		content: refund(15),
	};
	const first = await s.gw.call(claims, call);
	assert.equal((first as { status: string }).status, "done");
	assert.deepEqual(await s.gw.call(claims, call), first);
	// A tool that is not an action tool of the bot is refused, and nothing goes out.
	const read = await s.gw.call(claims, { ...call, callNo: 3, toolCallId: "call-2", tool: "read_file" });
	assert.equal((read as { status: string }).status, "refused");
	assert.equal(s.paid.length, 1);
});

test("G2: Petra handles SetRule and ApprovalDecision, so the Worker accepts them", () => {
	assert.ok(PETRA_HANDLES.includes("SetRule"));
	assert.ok(PETRA_HANDLES.includes("ApprovalDecision"));
});
