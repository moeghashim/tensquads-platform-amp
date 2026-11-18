// The shared tests of the ports that send to an outside service: channel and payment.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { SendOutcome } from "../lib/ports.js";

const OUTCOMES: readonly SendOutcome[] = ["confirmed", "not_sent", "unknown"];

export interface SendPort {
	send(id: string): Promise<SendOutcome>;
	status(id: string): Promise<SendOutcome>;
}

export function sendContract(title: string, make: () => Promise<SendPort>): void {
	describe(title, () => {
		test("a send gives one of the outcomes", async () => {
			const port = await make();
			const outcome = await port.send("send-1");
			assert.ok(OUTCOMES.includes(outcome), `The outcome "${outcome}" is not known.`);
		});

		test("the status after a send is the outcome of the send", async () => {
			const port = await make();
			const outcome = await port.send("send-1");
			assert.equal(await port.status("send-1"), outcome);
		});

		test('the status of an id that was never sent is "not_sent"', async () => {
			const port = await make();
			await port.send("send-1");
			assert.equal(await port.status("send-never"), "not_sent");
		});
	});
}
