import assert from "node:assert/strict";
import { test } from "node:test";

import { type ChannelMessage, type PaymentOrder, ports, type SendOutcome, startSystem } from "@tensquads/core";
import { channelContract, paymentContract } from "@tensquads/core/contract-tests";

import { sendHold, testChannel, testPayment } from "../src/index.js";

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

test("G9: a held payment is recorded at once, and answers only after the release", async () => {
	const paid: PaymentOrder[] = [];
	const { hold, release } = sendHold();
	const payment = (await startSystem([testPayment({ paid, hold })])).port(ports.payment);
	let answered = false;
	const sending = payment.pay({ id: "p-1", to: "cust-1", amount: 15, currency: "USD" }).then((outcome) => {
		answered = true;
		return outcome;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(paid.length, 1);
	assert.equal(answered, false);
	assert.equal(await payment.status("p-1"), "confirmed");
	release();
	assert.equal(await sending, "confirmed");
});

test("E2: in the mode with no outgoing action, each port records what it would send and logs it", async () => {
	const lines: string[] = [];
	const log = (line: string) => lines.push(line);
	const sent: ChannelMessage[] = [];
	const paid: PaymentOrder[] = [];
	const channel = (await startSystem([testChannel({ sent, log, record: true })])).port(ports.channel);
	const payment = (await startSystem([testPayment({ paid, log, record: true, answer: "unknown" })])).port(
		ports.payment,
	);
	assert.equal(await channel.send({ id: "t/call-1", to: "cust-1", text: "Hello." }), "confirmed");
	assert.equal(await payment.pay({ id: "t/call-2", to: "cust-1", amount: 15, currency: "USD" }), "unknown");
	assert.equal(sent.length, 1);
	assert.equal(paid.length, 1);
	assert.deepEqual(lines, [
		'channel-test: would send t/call-1 {"id":"t/call-1","to":"cust-1","text":"Hello."}',
		'payment-test: would send t/call-2 {"id":"t/call-2","to":"cust-1","amount":15,"currency":"USD"}',
	]);
});
