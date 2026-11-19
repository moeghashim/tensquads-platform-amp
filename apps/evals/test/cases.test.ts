import assert from "node:assert/strict";
import { test } from "node:test";

import { POINTS } from "@tensquads/decisions";

import { loadCases, loadDeciderItems, loadVersions } from "../src/files.js";
import { loadRealCases } from "../src/real.js";

test("E1: the five cases of the plan are files in evals/cases; each one parses and says that it was adapted", () => {
	const cases = loadCases();
	assert.deepEqual(cases.map((item) => item.id).sort(), ["D3", "K3", "P2", "R18", "S4"]);
	for (const item of cases) {
		assert.match(
			item.source,
			/^Plan Part 12, case \w+\. Adapted to the test bot/,
			`The case ${item.id} says it was adapted.`,
		);
		assert.equal(item.grader.kind, "code");
	}
	assert.deepEqual(
		loadCases(["K3"]).map((item) => item.id),
		["K3"],
	);
	assert.throws(() => loadCases(["Z9"]), /No case has the id Z9/);
});

test("E3: each version is a named settings file in evals/versions", () => {
	const versions = loadVersions(["base", "refund-double"]);
	assert.deepEqual(
		versions.map((version) => [version.name, version.worker.TEST_MODEL_SCRIPT]),
		[
			["base", "base"],
			["refund-double", "refund-double"],
		],
	);
	assert.throws(() => loadVersions(["none"]), /No version has the name none/);
});

test("E5: the labelled messages have 8 messages for each yes or no point, and half of them are in Arabic", () => {
	const items = loadDeciderItems();
	const points = POINTS.filter((point) => point.type === "yes_no").map((point) => point.id);
	assert.deepEqual([...new Set(items.map((item) => item.point))].sort(), [...points].sort());
	for (const point of points) {
		const own = items.filter((item) => item.point === point);
		assert.equal(own.length, 8, point);
		assert.equal(own.filter((item) => item.language === "ar").length, 4, point);
		assert.equal(own.filter((item) => item.answer === "yes").length, 4, point);
		assert.ok(own.filter((item) => item.language === "ar").every((item) => /\p{Script=Arabic}/u.test(item.message)));
	}
	assert.ok(items.filter((item) => item.point === "reason-in-rule").every((item) => item.rule !== undefined));
});

test("N8: the ten cases of the real model are in evals/cases/real; two are in Arabic, and the fake run skips them", () => {
	const cases = loadRealCases();
	assert.deepEqual(
		cases.map((item) => item.id),
		["REAL-J3", "REAL-J4", "REAL-J5", "REAL-J6", "REAL-J7", "REAL-P2", "REAL-P3", "REAL-P4", "REAL-P5", "REAL-P6"],
	);
	const arabic = cases.filter((item) =>
		item.input.some((step) => step.type === "OwnerMessage" && /\p{Script=Arabic}/u.test(step.text)),
	);
	assert.deepEqual(
		arabic.map((item) => item.id),
		["REAL-J3", "REAL-P2"],
	);
	assert.ok(!loadCases().some((item) => item.id.startsWith("REAL-")));
});
