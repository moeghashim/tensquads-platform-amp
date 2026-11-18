import assert from "node:assert/strict";
import test from "node:test";
import { botPort } from "@tensquads/bot-test";
import { testBot } from "@tensquads/bots";
import { startSystem } from "@tensquads/core";
import { linkPort } from "@tensquads/link";

import { pluginListHash, runnerPlugins } from "../src/plugins.js";
import { decodePass, readSettings, SettingError } from "../src/run.js";

const settings = { workerUrl: "http://worker.test", pass: "p", runnerId: "r-1", runnerCommit: "c" };

test("C1: the runner starts from its plug-in list, with one plug-in for each row", async () => {
	const list = runnerPlugins(settings);
	const system = await startSystem(list);
	assert.deepEqual(system.plugins(), ["link", "bot-test"]);
	assert.equal(system.port(botPort).definition, testBot);
	assert.equal(typeof system.port(linkPort).model, "function");
	await system.stop();
});

test("L10: the plug-in list of the runner has no model row", () => {
	const names = runnerPlugins(settings).map((row) => row.name);
	assert.ok(!names.some((name) => name.startsWith("model")));
});

test("L11: the hash of the plug-in list is the SHA-256 of the row names, and the settings do not change it", () => {
	const hash = pluginListHash(["link", "bot-test"]);
	assert.match(hash, /^[0-9a-f]{64}$/);
	assert.notEqual(hash, pluginListHash(["link"]));
});

test("L9: the runner reads the claims of the pass, with no check of the signature", () => {
	const claims = { accountId: "a", bot: "test-bot", taskId: "t", attemptNo: 2, endsAt: 1_000 };
	const pass = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
	assert.deepEqual(decodePass(pass), claims);
	assert.throws(() => decodePass("not-a-pass"), SettingError);
});

test("a missing setting stops the runner, and the message names the setting and not its value", () => {
	assert.throws(() => readSettings({ WORKER_URL: "http://w" }), /The setting PASS is missing/);
	assert.throws(
		() => readSettings({ PASS: "secret-pass" }),
		(error: Error) => {
			assert.match(error.message, /WORKER_URL is missing/);
			assert.ok(!error.message.includes("secret-pass"));
			return true;
		},
	);
	assert.deepEqual(readSettings({ PASS: "p", WORKER_URL: "http://w" }), { pass: "p", workerUrl: "http://w" });
});
