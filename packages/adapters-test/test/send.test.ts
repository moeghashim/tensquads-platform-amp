import assert from "node:assert/strict";
import { test } from "node:test";

import { type ChannelMessage, ports, type SendOutcome, startSystem } from "@tensquads/core";
import { channelContract, paymentContract } from "@tensquads/core/contract-tests";

import { testChannel, testPayment } from "../src/index.js";

const outcomes: readonly SendOutcome[] = ["confirmed", "not_sent", "unknown"];

for (const answer of outcomes) {
	channelContract(`channel-test (${answer})`, async () =>
		(await startSystem([testChannel({ answer })])).port(ports.channel),
	);
	paymentContract(`payment-test (${answer})`, async () =>
		(await startSystem([testPayment({ answer })])).port(ports.payment),
	);
}

test("channel-test records each send and gives the configured outcome", async () => {
	const sent: ChannelMessage[] = [];
	const channel = (await startSystem([testChannel({ sent, answer: "unknown" })])).port(ports.channel);
	const first = { id: "m-1", to: "customer-1", text: "Hello." };
	const second = { id: "m-2", to: "customer-2", text: "Bye." };

	assert.equal(await channel.send(first), "unknown");
	assert.equal(await channel.send(second), "unknown");

	assert.deepEqual(sent, [first, second]);
});

test('channel-test answers "confirmed" by default', async () => {
	const channel = (await startSystem([testChannel()])).port(ports.channel);
	assert.equal(await channel.send({ id: "m-1", to: "customer-1", text: "Hello." }), "confirmed");
});
