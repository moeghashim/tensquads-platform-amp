import assert from "node:assert/strict";
import test from "node:test";

import { scriptedModel } from "@tensquads/adapters-test";
import { type Plugin, type PortKey, ports, startSystem } from "@tensquads/core";

import { petraPlugins as petraList } from "../src/plugins/petra.js";
import { platformPlugins as platformList } from "../src/plugins/platform.js";

// The lists start with no database connection. A test that uses the database port gives one.
const petraPlugins = petraList({});
const platformPlugins = platformList({});

// A plug-in that uses the model port on "task/start". It does not know which adapter provides the port.
function asker(answers: string[]): Plugin {
	return {
		name: "asker",
		provides: [],
		needs: [ports.model],
		apply: (ctx) => {
			ctx.on("task/start", async ({ taskId }) => {
				const answer = await ctx
					.port(ports.model)
					.complete({ messages: [{ role: "user", content: taskId }], tools: [] });
				answers.push(answer.text);
			});
		},
	};
}

test("C1: Petra starts from her plug-in list, with one plug-in for each row", async () => {
	const system = await startSystem(petraPlugins);
	assert.deepEqual(
		system.plugins(),
		petraPlugins.map((row) => row.name),
	);
	const provided: PortKey<unknown>[] = [
		ports.model,
		ports.checkerModel,
		ports.sandbox,
		ports.decider,
		ports.identity,
		ports.channel,
		ports.payment,
	];
	provided.push(ports.database);
	for (const key of provided) {
		assert.ok(system.port(key), `the port "${key.name}" is provided`);
	}
	await system.stop();
});

test("C1: the Platform object starts from its plug-in list", async () => {
	const system = await startSystem(platformPlugins);
	assert.deepEqual(
		system.plugins(),
		platformPlugins.map((row) => row.name),
	);
	await system.stop();
});

test("C1: a test adapter is replaced with a second one, with no change to another row", async () => {
	const answers: string[] = [];
	const consumer = asker(answers);

	const first = await startSystem([...petraPlugins, consumer]);
	await first.emit("task/start", { taskId: "task-1" });
	await first.stop();

	const replaced = [...petraPlugins, consumer].map((row) =>
		row.name === "model-echo" ? scriptedModel([{ text: "an answer from the script" }]) : row,
	);
	const second = await startSystem(replaced);
	await second.emit("task/start", { taskId: "task-2" });
	await second.stop();

	assert.deepEqual(answers, ["task-1", "an answer from the script"]);
	// Each other row is the same value as in the list of Petra.
	const others = replaced.filter((row) => row.name !== "model-scripted");
	assert.deepEqual(
		others.map((row) => row.name),
		[...petraPlugins, consumer].map((row) => row.name).filter((name) => name !== "model-echo"),
	);
	for (const row of others) {
		assert.ok([...petraPlugins, consumer].includes(row), `the row "${row.name}" is not changed`);
	}
});
