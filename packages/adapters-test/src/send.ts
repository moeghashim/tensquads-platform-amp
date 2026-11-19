// The test adapters of the channel port and the payment port. Each one records each send.
// A send can wait until "hold" resolves. The service has the send from its start, so its status is known.
import { type ChannelMessage, type PaymentOrder, type Plugin, ports, type SendOutcome } from "@tensquads/core";

export interface SendOptions {
	// The outcome of each send. The default is "confirmed".
	answer?: SendOutcome;
	// Each send waits for this promise before it answers (requirements G9 and G12).
	hold?: () => Promise<void>;
	// Gets one line for each send, for example to show the sends of a Worker in its log.
	log?: (line: string) => void;
	// The mode with no outgoing action (requirement E2): the line of each send has what the port would send.
	record?: boolean;
}

// Records each item and gives the configured outcome. The status of an id that was never sent is "not_sent".
function recorder<T extends { id: string }>(name: string, list: T[], options: SendOptions) {
	const answer = options.answer ?? "confirmed";
	const outcomes = new Map<string, SendOutcome>();
	return {
		send: async (item: T): Promise<SendOutcome> => {
			list.push({ ...item });
			options.log?.(
				options.record ? `${name}: would send ${item.id} ${JSON.stringify(item)}` : `${name}: send ${item.id}`,
			);
			outcomes.set(item.id, answer);
			await options.hold?.();
			return answer;
		},
		status: async (id: string): Promise<SendOutcome> => outcomes.get(id) ?? "not_sent",
	};
}

export function testChannel(options: SendOptions & { sent?: ChannelMessage[] } = {}): Plugin {
	const sent = options.sent ?? [];
	return {
		name: "channel-test",
		provides: [ports.channel],
		needs: [],
		apply: (ctx) => {
			ctx.provide(ports.channel, { name: "test-channel", ...recorder("channel-test", sent, options) });
		},
	};
}

export function testPayment(options: SendOptions & { paid?: PaymentOrder[] } = {}): Plugin {
	const paid = options.paid ?? [];
	return {
		name: "payment-test",
		provides: [ports.payment],
		needs: [],
		apply: (ctx) => {
			const { send, status } = recorder("payment-test", paid, options);
			ctx.provide(ports.payment, { name: "test-payment", pay: send, status });
		},
	};
}

// A hold that a test releases. Each send waits until the next call of "release".
export function sendHold(): { hold: () => Promise<void>; release: () => void } {
	let waiting: (() => void)[] = [];
	return {
		hold: () => new Promise<void>((resolve) => waiting.push(resolve)),
		release: () => {
			for (const resolve of waiting) resolve();
			waiting = [];
		},
	};
}
