// The bridge from the pi-durable hooks to the cordis hook points.
import type { Context } from "cordis";
import {
	defineExtension,
	type Extension,
	GenerationTask,
	hook,
	ToolTask,
} from "@earendil-works/pi-durable";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

export interface BridgeOptions {
	// A text that the model must never get. beforeRequest removes it.
	forget?: () => string[];
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => (part as { text: string }).text)
		.join("");
}

function removeText(messages: readonly Message[], texts: string[]): Message[] {
	if (texts.length === 0) return [...messages];
	const clean = (value: string) => texts.reduce((acc, text) => acc.split(text).join("[removed]"), value);
	return messages.map((message) => {
		if (typeof message.content === "string") return { ...message, content: clean(message.content) } as Message;
		return {
			...message,
			content: message.content.map((part) =>
				part.type === "text" ? { ...part, text: clean((part as { text: string }).text) } : part,
			),
		} as Message;
	});
}

export function bridge(ctx: Context, options: BridgeOptions = {}): Extension {
	return defineExtension({
		name: "bridge",
		hooks: [
			hook(GenerationTask, {
				beforeRequest: (request) => {
					ctx.emit("model/before", { messages: request.messages.length });
					const texts = options.forget?.() ?? [];
					return texts.length === 0 ? undefined : { messages: removeText(request.messages, texts) };
				},
				afterTools: (_assistant, results) => {
					ctx.emit("turn/end", { results: results.length });
				},
				onYield: (answer) => {
					const reason = ctx.bail("answer/check", { text: textOf(answer) });
					return reason === undefined ? undefined : { continue: reason };
				},
			}),
			hook(ToolTask, {
				beforeTool: (call) => {
					const block = ctx.bail("tool/before", { name: call.name, id: call.id });
					return block === undefined ? undefined : { block };
				},
				afterTool: (call) => {
					ctx.emit("tool/after", { name: call.name, id: call.id });
					return undefined;
				},
			}),
		],
	});
}
