// The contract of the payment port. Each payment adapter must pass these tests.
import type { Payment } from "../lib/ports.js";
import { sendContract } from "./send.js";

// Registers the tests of the payment port. The make function gives a new payment for each test.
export function paymentContract(name: string, make: () => Promise<Payment>): void {
	sendContract(`${name}: payment contract`, async () => {
		const payment = await make();
		return {
			send: (id) => payment.pay({ id, to: "customer-1", amount: 1250, currency: "USD" }),
			status: (id) => payment.status(id),
		};
	});
}
