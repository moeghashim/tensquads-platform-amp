// The test adapters of the channel port and the payment port. Each one records each send.
import { type ChannelMessage, type PaymentOrder, type Plugin, ports, type SendOutcome } from "@tensquads/core";

// Records each item and gives the configured outcome. The status of an id that was never sent is "not_sent".
function recorder<T extends { id: string }>(list: T[], answer: SendOutcome) {
	const outcomes = new Map<string, SendOutcome>();
	return {
		send: async (item: T): Promise<SendOutcome> => {
			list.push({ ...item });
			outcomes.set(item.id, answer);
			return answer;
		},
		status: async (id: string): Promise<SendOutcome> => outcomes.get(id) ?? "not_sent",
	};
}

export function testChannel(options: { sent?: ChannelMessage[]; answer?: SendOutcome } = {}): Plugin {
	const sent = options.sent ?? [];
	return {
		name: "channel-test",
		provides: [ports.channel],
		needs: [],
		apply: (ctx) => {
			ctx.provide(ports.channel, recorder(sent, options.answer ?? "confirmed"));
		},
	};
}

export function testPayment(options: { paid?: PaymentOrder[]; answer?: SendOutcome } = {}): Plugin {
	const paid = options.paid ?? [];
	return {
		name: "payment-test",
		provides: [ports.payment],
		needs: [],
		apply: (ctx) => {
			const { send, status } = recorder(paid, options.answer ?? "confirmed");
			ctx.provide(ports.payment, { pay: send, status });
		},
	};
}
