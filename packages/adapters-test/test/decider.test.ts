import assert from "node:assert/strict";
import { test } from "node:test";

import { ports, startSystem } from "@tensquads/core";
import { deciderContract } from "@tensquads/core/contract-tests";

import { fixedDecider } from "../src/index.js";

deciderContract("decider-fixed", async () => (await startSystem([fixedDecider()])).port(ports.decider));
deciderContract("decider-fixed with an answer", async () =>
	(await startSystem([fixedDecider({ answer: "no", probability: 0.4 })])).port(ports.decider),
);

test("decider-fixed gives the fixed answer when it is an option, and else the first option", async () => {
	const decider = (await startSystem([fixedDecider({ answer: "no", probability: 0.4 })])).port(ports.decider);
	const answers = await decider.ask([
		{ id: "q-1", point: "task/start", text: "Is it clear?", options: ["yes", "no"] },
		{ id: "q-2", point: "task/start", text: "Which bot?", options: ["support", "sales"] },
	]);
	assert.deepEqual(answers, [
		{ id: "q-1", answer: "no", probability: 0.4 },
		{ id: "q-2", answer: "support", probability: 0.4 },
	]);
});
