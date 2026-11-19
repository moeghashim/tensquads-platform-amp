import assert from "node:assert/strict";
import test from "node:test";

import { modelDecider, ruleChecker, scriptedModel } from "@tensquads/adapters-test";
import { testBot } from "@tensquads/bots";
import { checker } from "@tensquads/checker";
import { type Plugin, type PortKey, ports, startSystem } from "@tensquads/core";

import { type EvalVars, evalSettings } from "../src/eval-settings.js";
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
		ports.shadowDecider,
		ports.identity,
		ports.channel,
		ports.payment,
	];
	provided.push(ports.database);
	for (const key of provided) {
		// The port of the shadow decider is null when no shadow runs. It is still provided.
		assert.doesNotThrow(() => system.port(key), `the port "${key.name}" is provided`);
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
	const usage = [{ requestId: "rule-check-1", provider: "test", model: "rule-check", units: 1, unit: "call" }];
	assert.deepEqual(verdict, { pass: false, reason: "The result does not answer the goal.", usage });
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

test("Q8: the model decider replaces the row of the fixed decider, and no other row or package changes", async () => {
	const second = modelDecider();
	const list = petraPlugins.map((row) => (row.name === "decider-fixed" ? second : row));
	assert.equal(list.filter((row, index) => row !== petraPlugins[index]).length, 1);
	const question = {
		id: "q-1",
		point: "request-clear",
		type: "yes_no" as const,
		text: "Is it clear?",
		options: ["yes", "no"],
	};
	const before = await startSystem(petraPlugins);
	const after = await startSystem(list);
	assert.equal(before.port(ports.decider).name, "fixed");
	assert.equal(after.port(ports.decider).name, "model");
	// The rule model of the list answers the questions of the model decider (task 09).
	const [answer] = await after.port(ports.decider).ask([question]);
	assert.deepEqual(answer && [answer.id, answer.answer, answer.probability], ["q-1", "yes", 0.95]);
	// The model decider reports the tokens of its model call, for the cost rows (requirement S1).
	assert.deepEqual(
		answer?.usage?.map((item) => [item.provider, item.model, item.unit]),
		[
			["test", "rule", "1M input tokens"],
			["test", "rule", "1M output tokens"],
		],
	);
	assert.equal(after.port(ports.shadowDecider), null, "The row of the shadow mode does not change.");
	await before.stop();
	await after.stop();
});

const settingsOf = (vars: EvalVars) => ({ evals: evalSettings(vars) });

test("E2: with no eval settings, the Worker keeps its behaviour: the ports send, and the defaults stay", () => {
	assert.deepEqual(settingsOf({}).evals, {
		noOutgoingAction: false,
		evalOwners: false,
		channelOutcome: "confirmed",
		paymentOutcome: "confirmed",
		deciderPoints: {},
		modelScript: "base",
		modelHoldMs: 0,
	});
	assert.throws(() => settingsOf({ MODEL_HOLD_MS: "-1" }), /MODEL_HOLD_MS/);
	assert.throws(() => settingsOf({ NO_OUTGOING_ACTION: "maybe" }), /NO_OUTGOING_ACTION/);
	assert.throws(() => settingsOf({ CHANNEL_OUTCOME: "lost" }), /CHANNEL_OUTCOME/);
	assert.throws(() => settingsOf({ FIXED_DECIDER_POINTS: "[1]" }), /FIXED_DECIDER_POINTS/);
	assert.throws(() => settingsOf({ TEST_MODEL_SCRIPT: "other" }), /TEST_MODEL_SCRIPT/);
});

test("E2 and E3: the settings of an eval Worker give the rows of Petra: no outgoing action, the outcomes, the fixed answers and the script", async () => {
	const { evals } = settingsOf({
		NO_OUTGOING_ACTION: "yes",
		EVAL_OWNERS: "yes",
		CHANNEL_OUTCOME: "unknown",
		PAYMENT_OUTCOME: "not_sent",
		FIXED_DECIDER_POINTS: '{"request-clear":{"answer":"no"}}',
		TEST_MODEL_SCRIPT: "refund-double",
	});
	const lines: string[] = [];
	const system = await startSystem(petraList({}, { ...fakeBindings, evals, log: (line) => lines.push(line) }));
	assert.equal(await system.port(ports.channel).send({ id: "t/call-1", to: "cust-1", text: "Hi." }), "unknown");
	const order = { id: "t/call-2", to: "cust-1", amount: 30, currency: "USD" };
	assert.equal(await system.port(ports.payment).pay(order), "not_sent");
	assert.deepEqual(
		lines.map((line) => line.split(" ").slice(0, 4).join(" ")),
		["channel-test: would send t/call-1", "payment-test: would send t/call-2"],
	);
	const question = {
		id: "q",
		point: "request-clear",
		type: "yes_no" as const,
		text: "Clear?",
		options: ["yes", "no"],
	};
	const [answer] = await system.port(ports.decider).ask([question]);
	assert.equal(answer?.answer, "no");
	const refund = await system
		.port(ports.model)
		.complete({ messages: [{ role: "user", content: "Goal: refund 15 to cust-1" }], tools: [] });
	assert.deepEqual(refund.toolCalls[0]?.input, { amount: 30, to: "cust-1", currency: "USD" });
	await system.stop();
	const identity = (await startSystem(platformList({}, { evalOwners: evals.evalOwners }))).port(ports.identity);
	assert.equal((await identity.whoIs("eval-owner:eval-1"))?.kind, "owner");
});
