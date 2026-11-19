import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendFile, readFile } from "@tensquads/bot-test";

// Requirement E6: the cases and the graders are outside the sandbox. A bot under eval cannot read or change them.
const ROOT = join(import.meta.dirname, "..", "..", "..");
const CASE = join(ROOT, "evals", "cases", "k3.json");

test("E6: the file tools of the test bot refuse a relative path and an absolute path into the cases", async () => {
	const workDir = mkdtempSync(join(tmpdir(), "tensquads-e6-"));
	try {
		const paths = ["../../evals/cases/k3.json", "../".repeat(12) + CASE.slice(1), CASE];
		for (const path of paths) {
			await assert.rejects(readFile({ path }, workDir), /not inside the work directory/, path);
			await assert.rejects(appendFile({ path, text: "x" }, workDir), /not inside the work directory/, path);
		}
		// Control: the case exists, so the refusal is not because the file is missing.
		assert.match(readFileSync(CASE, "utf8"), /"K3"/);
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
});

// The word "evals" in any file of the runner, the link or the test bot is a possible path to the cases.
const EVALS = /evals/i;

function files(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && !/(^|\/)(node_modules|dist)(\/|$)/.test(entry.parentPath))
		.map((entry) => join(entry.parentPath, entry.name));
}

test("E6: no file of the runner, the link or the test bot names the evals", () => {
	const all = ["apps/runner", "packages/link", "packages/bot-test"].flatMap((dir) => files(join(ROOT, dir)));
	assert.ok(
		all.some((file) => file.endsWith("run.ts")),
		"The check reads the files of the runner.",
	);
	for (const file of all) {
		assert.doesNotMatch(readFileSync(file, "utf8"), EVALS, `The file ${file} names the evals.`);
	}
	// Control: the check sees a path to the cases.
	assert.match('readFileSync("../../evals/cases/k3.json")', EVALS);
});
