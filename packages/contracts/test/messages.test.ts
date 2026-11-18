import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { OWNER_MESSAGE_TYPES, ownerMessage } from "../src/index.js";

const at = "2026-11-18T10:00:00Z";

// One valid sample of each type.
const samples: Record<string, Record<string, unknown>> = {
	reply: { seq: 1, at, type: "reply", text: "Hello." },
	question: {
		seq: 2,
		at,
		type: "question",
		questionId: "q-1",
		text: "Which size?",
		options: ["small", "large"],
	},
	approval_request: {
		seq: 3,
		at,
		type: "approval_request",
		approvalId: "a-1",
		action: "send_refund",
		content: "Refund 20 USD to Sara.",
		contentHash: "sha256:abc",
		rule: "rule-1",
		limit: 10_000_000,
	},
	result: {
		seq: 4,
		at,
		type: "result",
		taskId: "t-1",
		summary: "The refund is sent.",
		evidence: ["msg-7"],
	},
	status: {
		seq: 5,
		at,
		type: "status",
		taskId: "t-1",
		bot: "support",
		attempt: 1,
		step: "reads the order",
		since: at,
	},
	action_not_confirmed: {
		seq: 6,
		at,
		type: "action_not_confirmed",
		taskId: "t-1",
		actionId: "call-3",
		what: "The refund service did not answer.",
	},
};

function issuePaths(input: unknown): string[] {
	const parsed = ownerMessage.safeParse(input);
	assert.equal(parsed.success, false);
	return parsed.error?.issues.map((issue) => issue.path.join(".")) ?? [];
}

test("O1: each of the six types parses a valid sample", () => {
	for (const type of OWNER_MESSAGE_TYPES) {
		const sample = samples[type];
		assert.ok(sample, `No sample for ${type}.`);
		const parsed = ownerMessage.safeParse(sample);
		assert.equal(parsed.success, true, `${type}: ${JSON.stringify(parsed.error?.issues)}`);
	}
});

test("O1: the union has exactly the six types", () => {
	const types = ownerMessage.options.map((option) => option.shape.type.value);
	assert.deepEqual([...types].sort(), [...OWNER_MESSAGE_TYPES].sort());
	assert.equal(types.length, 6);
});

test("O1: a message with seq 0 or no at fails", () => {
	assert.deepEqual(issuePaths({ ...samples.reply, seq: 0 }), ["seq"]);
	const { at: _at, ...noAt } = samples.reply ?? {};
	assert.deepEqual(issuePaths(noAt), ["at"]);
});

test("O2: a message with a color or layout field fails", () => {
	assert.deepEqual(issuePaths({ ...samples.reply, color: "red" }), [""]);
	assert.deepEqual(issuePaths({ ...samples.result, layout: "card" }), [""]);
});

// Collect each key of an object schema, and of the schemas inside it.
function keysOf(schema: z.ZodType): string[] {
	if (schema instanceof z.ZodObject) {
		return Object.entries(schema.shape).flatMap(([key, value]) => [key, ...keysOf(value as z.ZodType)]);
	}
	if (schema instanceof z.ZodArray) {
		return keysOf(schema.element as z.ZodType);
	}
	if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional) {
		return keysOf(schema.unwrap() as z.ZodType);
	}
	return [];
}

test("O2: no key of the six types names a layout, a colour, a component or a style", () => {
	const keys = ownerMessage.options.flatMap((option) => keysOf(option));
	assert.ok(keys.includes("text"), "The walk found no keys.");
	const bad = keys.filter((key) => /layout|colou?r|component|style/i.test(key));
	assert.deepEqual(bad, []);
});
