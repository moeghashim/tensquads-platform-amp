// The contract of the channel port. Each channel adapter must pass these tests.
import type { Channel } from "../lib/ports.js";
import { sendContract } from "./send.js";

// Registers the tests of the channel port. The make function gives a new channel for each test.
export function channelContract(name: string, make: () => Promise<Channel>): void {
	sendContract(`${name}: channel contract`, async () => {
		const channel = await make();
		return {
			send: (id) => channel.send({ id, to: "customer-1", text: "Your order is ready." }),
			status: (id) => channel.status(id),
		};
	});
}
