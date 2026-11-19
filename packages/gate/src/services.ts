// The services of the actions: the payment port for "money" and the channel port for "public".
// An action of the kind "other" has no service in this build. It is done at once.
import type { Channel, Payment, SendOutcome } from "@tensquads/core";

import { canonicalJson } from "./hash.js";
import type { ActionKind } from "./types.js";

export interface Services {
	payment: Payment;
	channel: Channel;
}

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

// The problem of a content, or undefined when the service can take it.
export function contentProblem(kind: ActionKind, content: Record<string, unknown>): string | undefined {
	if (kind === "money") {
		const { to, amount, currency } = content;
		if (!isText(to)) return "A money action needs the text field 'to'.";
		if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
			return "A money action needs a positive number 'amount', in US dollars.";
		}
		if (currency !== undefined && !isText(currency)) return "The field 'currency' must be a text.";
	}
	if (kind === "public" && (!isText(content.to) || !isText(content.text))) {
		return "A public action needs the text fields 'to' and 'text'.";
	}
	return undefined;
}

// The content was checked with contentProblem before the action row was written.
export function sendAction(
	services: Services,
	id: string,
	kind: ActionKind,
	content: Record<string, unknown>,
): Promise<SendOutcome> {
	if (kind === "money") {
		const currency = typeof content.currency === "string" ? content.currency : "USD";
		return services.payment.pay({ id, to: String(content.to), amount: Number(content.amount), currency });
	}
	if (kind === "public") return services.channel.send({ id, to: String(content.to), text: String(content.text) });
	return Promise.resolve("confirmed");
}

export function serviceStatus(services: Services, id: string, kind: ActionKind): Promise<SendOutcome> {
	if (kind === "money") return services.payment.status(id);
	if (kind === "public") return services.channel.status(id);
	return Promise.resolve("confirmed");
}

// The provider of the cost row of an action, or undefined for an action with no service.
export function providerOf(services: Services, kind: ActionKind): string | undefined {
	if (kind === "money") return services.payment.name ?? "payment";
	if (kind === "public") return services.channel.name ?? "channel";
	return undefined;
}

// The text that the owner reads about an action.
export const describeAction = (tool: string, content: Record<string, unknown>): string =>
	`${tool} ${canonicalJson(content)}`;
