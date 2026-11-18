import assert from "node:assert/strict";
import test from "node:test";

import { ports, startSystem } from "@tensquads/core";

import { runnerPlugins } from "../src/plugins.js";

test("C1: the runner starts from its plug-in list, with one plug-in for each row", async () => {
	const system = await startSystem(runnerPlugins);
	assert.deepEqual(
		system.plugins(),
		runnerPlugins.map((row) => row.name),
	);
	const answer = await system
		.port(ports.model)
		.complete({ messages: [{ role: "user", content: "hello" }], tools: [] });
	assert.equal(answer.text, "hello");
	await system.stop();
});
