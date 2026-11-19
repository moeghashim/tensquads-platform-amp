import assert from "node:assert/strict";
import test from "node:test";

import { type Plugin, PluginListError, ports, startSystem } from "../src/index.js";

const fixedModel = {
	complete: async () => ({
		text: "ok",
		toolCalls: [],
		provider: "test",
		model: "fixed",
		requestId: "r-1",
		usage: { inputTokens: 1, outputTokens: 1 },
	}),
};

const modelPlugin: Plugin = {
	name: "model-fixed",
	provides: [ports.model],
	needs: [],
	apply: (ctx) => ctx.provide(ports.model, fixedModel),
};

function refuser(name: string, word: string): Plugin {
	return {
		name,
		provides: [],
		needs: [ports.model],
		apply: (ctx) => {
			ctx.port(ports.model);
			ctx.on("answer/check", (info) => (info.text.includes(word) ? `${name} refuses "${word}"` : undefined));
			ctx.on("task/end", () => undefined);
		},
	};
}

test("C5: the start fails with a clear message when a plug-in needs a port that no plug-in provides", async () => {
	await assert.rejects(startSystem([refuser("gate", "x")]), {
		name: "PluginListError",
		message: 'The plug-in "gate" needs the port "model". No plug-in in the list provides it.',
	});
});

test("C5: the start fails before any plug-in runs", async () => {
	let applied = false;
	const early: Plugin = {
		name: "early",
		provides: [],
		needs: [],
		apply: () => {
			applied = true;
		},
	};
	await assert.rejects(startSystem([early, refuser("gate", "x")]), PluginListError);
	assert.equal(applied, false);
});

test("C5: the start fails when the provider of a port comes after the plug-in that needs it", async () => {
	await assert.rejects(startSystem([refuser("gate", "x"), modelPlugin]), /comes later in the list/);
});

test("C5: the start fails when two plug-ins provide the same port", async () => {
	await assert.rejects(
		startSystem([modelPlugin, { ...modelPlugin, name: "model-other" }]),
		/both provide the port "model"/,
	);
});

test("C5: a plug-in cannot use a port that its row does not declare", async () => {
	const sly: Plugin = { name: "sly", provides: [], needs: [], apply: (ctx) => void ctx.port(ports.model) };
	await assert.rejects(startSystem([modelPlugin, sly]), /does not declare it in "needs"/);
});

test("C6: a plug-in that is removed leaves no hook and no handler", async () => {
	const system = await startSystem([modelPlugin, refuser("gate", "draft"), refuser("checker", "secret")]);
	const before = system.hookCount();
	assert.equal(await system.ask("answer/check", { taskId: "t1", text: "a draft" }), 'gate refuses "draft"');

	await system.remove("gate");

	assert.equal(system.hookCount(), before - 2);
	assert.equal(await system.ask("answer/check", { taskId: "t1", text: "a draft" }), undefined);
	assert.equal(await system.ask("answer/check", { taskId: "t1", text: "a secret" }), 'checker refuses "secret"');
	assert.deepEqual(system.plugins(), ["model-fixed", "checker"]);
});

test("C6: a plug-in that is removed takes its port with it", async () => {
	const system = await startSystem([modelPlugin]);
	assert.equal(system.port(ports.model), fixedModel);
	await system.remove("model-fixed");
	assert.throws(() => system.port(ports.model), /No plug-in in the system provides the port "model"/);
});

test("C6: stop removes the plug-ins in the reverse order of the list", async () => {
	const order: string[] = [];
	const tracked = (name: string): Plugin => ({
		name,
		provides: [],
		needs: [],
		apply: (ctx) => {
			ctx.on("task/end", () => undefined);
			ctx.onRemove(() => void order.push(name));
		},
	});
	const system = await startSystem([tracked("first"), tracked("second"), tracked("third")]);
	await system.stop();
	assert.deepEqual(order, ["third", "second", "first"]);
	assert.deepEqual(system.plugins(), []);
	assert.equal(system.hookCount(), 0);
});
