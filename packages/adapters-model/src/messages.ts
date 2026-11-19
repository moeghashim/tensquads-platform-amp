// The messages of the model port, as messages of pi-ai, and the answer of pi-ai as an answer of the port.
// The port has text messages only. An assistant message with tool calls and a tool result are JSON text
// (packages/loop, gateway-model.ts). This module reads that JSON back.
import type { Api, AssistantMessage, Context, Message, Model as PiModel, Tool } from "@earendil-works/pi-ai";
import type { ModelAnswer, ModelMessage, ModelRequest } from "@tensquads/core";

type JsonObject = Record<string, never>;

interface ToolCallText {
	text?: unknown;
	toolCalls?: unknown;
}

interface ToolResultText {
	toolCallId?: unknown;
	tool?: unknown;
	output?: unknown;
	isError?: unknown;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

const NO_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// An old answer of the conversation. The conversation does not record the model that gave it. After a swap, it can
// come from another provider, with tool call ids that the new provider refuses. Thus the answer has its own model
// name, and pi-ai makes its tool call ids valid for the model of this request.
const HISTORY_MODEL = "history";

function assistantMessage(model: PiModel<Api>, content: string): AssistantMessage {
	const parsed = parseJson(content) as ToolCallText | undefined;
	const calls = Array.isArray(parsed?.toolCalls)
		? (parsed.toolCalls as { id: string; name: string; input: unknown }[])
		: [];
	const text = calls.length > 0 && typeof parsed?.text === "string" ? parsed.text : calls.length > 0 ? "" : content;
	return {
		role: "assistant",
		content: [
			...(text === "" ? [] : [{ type: "text" as const, text }]),
			...calls.map((call) => ({
				type: "toolCall" as const,
				id: call.id,
				name: call.name,
				arguments: (call.input ?? {}) as JsonObject,
			})),
		],
		api: model.api,
		provider: model.provider,
		model: HISTORY_MODEL,
		usage: NO_USAGE,
		stopReason: calls.length > 0 ? "toolUse" : "stop",
		timestamp: 0,
	};
}

function toolResult(content: string): Message {
	const parsed = (parseJson(content) ?? {}) as ToolResultText;
	return {
		role: "toolResult",
		toolCallId: String(parsed.toolCallId ?? ""),
		toolName: String(parsed.tool ?? ""),
		content: [{ type: "text", text: typeof parsed.output === "string" ? parsed.output : content }],
		isError: parsed.isError === true,
		timestamp: 0,
	};
}

// The system messages become the system prompt. The other messages keep their sequence.
export function contextOf(model: PiModel<Api>, request: ModelRequest): Context {
	const system = request.messages.filter((message) => message.role === "system").map((message) => message.content);
	const messages = request.messages.flatMap((message: ModelMessage): Message[] => {
		if (message.role === "user") return [{ role: "user", content: message.content, timestamp: 0 }];
		if (message.role === "assistant") return [assistantMessage(model, message.content)];
		if (message.role === "tool") return [toolResult(message.content)];
		return [];
	});
	const tools: Tool[] = (request.toolDefinitions ?? []).map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
	return {
		...(system.length > 0 ? { systemPrompt: system.join("\n\n") } : {}),
		messages,
		...(tools.length > 0 ? { tools } : {}),
	};
}

// The answer of the port. The input units include the tokens that the provider read from its cache.
export function answerOf(message: AssistantMessage, requestId: string): ModelAnswer {
	const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	const toolCalls = message.content.flatMap((part) =>
		part.type === "toolCall" ? [{ id: part.id, name: part.name, input: part.arguments }] : [],
	);
	const { input, cacheRead, cacheWrite, output } = message.usage;
	return {
		text,
		toolCalls,
		requestId: message.responseId ?? requestId,
		provider: message.provider,
		model: message.model,
		usage: { inputTokens: input + cacheRead + cacheWrite, outputTokens: output },
	};
}
