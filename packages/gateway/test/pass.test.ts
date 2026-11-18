import assert from "node:assert/strict";
import test from "node:test";

import { signPass, verifyPass } from "../src/index.js";

const KEY = "test-signing-key";
const NOW = Date.parse("2026-11-18T10:00:00.000Z");
const claims = { accountId: "a1", bot: "test-bot", taskId: "t1", attemptNo: 1, endsAt: NOW + 60_000 };

test("L9: a pass that is signed with the key gives its claims before its end time", async () => {
	const token = await signPass(claims, KEY);
	assert.deepEqual(await verifyPass(token, KEY, NOW), claims);
});

test("L9: a pass after its end time is refused", async () => {
	const token = await signPass(claims, KEY);
	assert.equal(await verifyPass(token, KEY, claims.endsAt), undefined);
	assert.equal(await verifyPass(token, KEY, claims.endsAt + 1), undefined);
});

test("L9: a pass with a bad signature is refused", async () => {
	const token = await signPass(claims, KEY);
	assert.equal(await verifyPass(token, "another-key", NOW), undefined);
	// The claims of another attempt with the signature of this pass.
	const [, signature] = token.split(".");
	const changed = Buffer.from(JSON.stringify({ ...claims, attemptNo: 2 })).toString("base64url");
	assert.equal(await verifyPass(`${changed}.${signature}`, KEY, NOW), undefined);
});

test("L9: a pass with a bad form is refused", async () => {
	const token = await signPass(claims, KEY);
	for (const bad of ["", "abc", `${token}.x`, `.${token.split(".")[1]}`, `${token.split(".")[0]}.`, "a+b.c/d"]) {
		assert.equal(await verifyPass(bad, KEY, NOW), undefined, bad);
	}
});

test("L9: a signed pass with claims that do not match the schema is refused", async () => {
	await assert.rejects(signPass({ ...claims, attemptNo: 0 }, KEY));
});
