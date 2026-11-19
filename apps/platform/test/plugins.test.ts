import assert from "node:assert/strict";
import test from "node:test";

import { ruleChecker, scriptedModel } from "@tensquads/adapters-test";
import { testBot } from "@tensquads/bots";
import { checker } from "@tensquads/checker";
import { type Plugin, type PortKey, ports, startSystem } from "@tensquads/core";

import { petraPlugins as petraList } from "../src/plugins/petra.js";
import { platformPlugins as platformList } from "../src/plugins/platform.js";

// The bindings of the Worker, as fakes. No test here uses them.
const fakeBindings = {
	accountId: "account-a",
	bucket: { put: async () => undefined, get: async () => null, delete: async () => undefined },
	jobs: { send: async () => undefined },
	platform: { fetch: async () => Response.json({ ok: true }) },
};

// The lists start with no database connection. A test that uses the database port gives one.
const petraPlugins = petraList({}, fakeBindings);
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
		ports.objectStore,
		ports.queue,
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
		row.name === "model-rule" ? scriptedModel([{ text: "an answer from the script" }]) : row,
	);
	const second = await startSystem(replaced);
	await second.emit("task/start", { taskId: "task-2" });
	await second.stop();

	assert.deepEqual(answers, ["task-1", "an answer from the script"]);
	// Each other row is the same value as in the list of Petra.
	const others = replaced.filter((row) => row.name !== "model-scripted");
	assert.deepEqual(
		others.map((row) => row.name),
		[...petraPlugins, consumer].map((row) => row.name).filter((name) => name !== "model-rule"),
	);
	for (const row of others) {
		assert.ok([...petraPlugins, consumer].includes(row), `the row "${row.name}" is not changed`);
	}
});

test("L8: one changed row of the list of Petra replaces the checker, and the other rows stay", async () => {
	const failing = ruleChecker(() => ({ pass: false, reason: "The result does not answer the goal." }));
	const list = petraPlugins.map((row) => (row.name === failing.name ? failing : row));
	assert.equal(list.filter((row, index) => row !== petraPlugins[index]).length, 1);
	const system = await startSystem(list);
	const verdict = await system.port(ports.checkerModel).check({ taskId: "t", goal: "g", result: "r" });
	assert.deepEqual(verdict, { pass: false, reason: "The result does not answer the goal." });
	const before = await startSystem(petraPlugins);
	assert.equal((await before.port(ports.checkerModel).check({ taskId: "t", goal: "g", result: "r" })).pass, true);
	await system.stop();
	await before.stop();
});

// A second adapter of the checker model port. It fails each result that does not name the shop.
const shopChecker: Plugin = {
	name: "checker-model-shop",
	provides: [ports.checkerModel],
	needs: [],
	apply: (ctx) => {
		ctx.provide(ports.checkerModel, {
			check: async ({ result }) =>
				/\bshop\b/i.test(result)
					? { pass: true, reason: "The result names the shop." }
					: { pass: false, reason: "The result does not name the shop." },
		});
	},
};

test("K2: a second adapter replaces the row of the checker model, and the row of the model of the bot does not change", async () => {
	const list = petraPlugins.map((row) => (row.provides.includes(ports.checkerModel) ? shopChecker : row));
	assert.equal(list.filter((row, index) => row !== petraPlugins[index]).length, 1);
	const modelRow = petraPlugins.find((row) => row.provides.includes(ports.model));
	assert.equal(modelRow?.name, "model-rule");
	assert.ok(list.includes(modelRow), "The row of the model of the bot is the same row.");
	assert.notEqual(modelRow, shopChecker, "The maker is not the checker.");

	const brief = {
		goal: "Tell the hours.",
		done: "The owner has the answer.",
		facts: [],
		limits: { maxTurns: 10, maxBudget: 0.5 },
		notInTask: [],
		replyTo: "t",
	};
	const result = (answer: string) => ({
		stop: "success" as const,
		answer,
		evidence: [],
		proposedFacts: [],
		notes: [],
	});
	const system = await startSystem(list);
	const check = checker(system.port(ports.checkerModel));
	const input = { taskId: "t", bot: testBot.id, brief, forget: [] };
	assert.deepEqual(await check({ ...input, result: result("Open at 9.") }), {
		verdict: "continue",
		reason: "Checker model: The result does not name the shop.",
	});
	assert.equal((await check({ ...input, result: result("The shop opens at 9.") })).verdict, "stands");
	// The model of the bot is the rule model in both lists.
	const before = await startSystem(petraPlugins);
	const request = { messages: [{ role: "user" as const, content: "Goal: read 1 file" }], tools: [] };
	assert.deepEqual(await system.port(ports.model).complete(request), await before.port(ports.model).complete(request));
	await system.stop();
	await before.stop();
});
