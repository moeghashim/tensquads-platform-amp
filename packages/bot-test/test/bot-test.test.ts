import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { testBot } from "@tensquads/bots";

import { appendFile, calculate, readFile, TEST_FILES, testBotRunner } from "../src/index.js";

function workDir(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "bot-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const NO_DIR = "/nonexistent-work-dir";

test("L13: the runner plug-in has the definition of the test bot from packages/bots", () => {
	assert.equal(testBotRunner.definition, testBot);
	assert.ok(testBotRunner.instructions.length > 0);
});

test("the plug-in has one tool for each read tool and compute tool of the definition, and no action tool", () => {
	const sandboxTools = testBot.tools.filter((tool) => tool.kind !== "action").map((tool) => tool.name);
	assert.deepEqual(Object.keys(testBotRunner.tools).sort(), sandboxTools.sort());
});

test("read_file gives the content of a file of the bot", async () => {
	assert.equal(await readFile({ path: "shop/hours.txt" }, NO_DIR), TEST_FILES["shop/hours.txt"]);
	await assert.rejects(readFile({ path: "secret.txt" }, NO_DIR), /No file has the path "secret.txt"/);
	await assert.rejects(readFile({}, NO_DIR), /needs the text field "path"/);
});

test("G11: append_file adds text at the end of a file of the work directory, and read_file reads it", async (t) => {
	const dir = workDir(t);
	assert.match(await appendFile({ path: "notes/a.txt", text: "one\n" }, dir), /Added 4 characters/);
	await appendFile({ path: "notes/a.txt", text: "two\n" }, dir);
	assert.equal(readFileSync(join(dir, "notes/a.txt"), "utf8"), "one\ntwo\n");
	assert.equal(await readFile({ path: "notes/a.txt" }, dir), "one\ntwo\n");
	await assert.rejects(appendFile({ path: "../out.txt", text: "x" }, dir), /not inside the work directory/);
	await assert.rejects(readFile({ path: "../../etc/passwd" }, dir), /not inside the work directory/);
	await assert.rejects(appendFile({ path: "shop/hours.txt", text: "x" }, dir), /file of the bot/);
	await assert.rejects(appendFile({ path: "a.txt" }, dir), /needs the text field "text"/);
});

test("calculate gives the result of one operation", async () => {
	assert.equal(await calculate({ op: "add", a: 2, b: 3 }, NO_DIR), "5");
	assert.equal(await calculate({ op: "subtract", a: 2, b: 3 }, NO_DIR), "-1");
	assert.equal(await calculate({ op: "multiply", a: 12, b: 3 }, NO_DIR), "36");
	assert.equal(await calculate({ op: "divide", a: 9, b: 2 }, NO_DIR), "4.5");
	await assert.rejects(calculate({ op: "divide", a: 1, b: 0 }, NO_DIR), /cannot divide by zero/);
	await assert.rejects(calculate({ op: "power", a: 1, b: 2 }, NO_DIR), /needs "op"/);
	await assert.rejects(calculate({ op: "toString", a: 1, b: 2 }, NO_DIR), /needs "op"/);
	await assert.rejects(calculate({ op: "add", a: "1", b: 2 }, NO_DIR), /needs the numbers/);
});
