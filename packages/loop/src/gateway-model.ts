import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { ModelAnswer, ModelMessage } from "@tensquads/core";

// The model of the loop. pi-durable asks pi-ai for each completion. pi-ai has one provider only: this one.
// The provider gives each request to a function: the link for a bot (requirement L10), the model port for Petra.
// Thus no code of the loop calls a model provider directly.

export const GATEWAY_MODEL: ModelRef = { provider: "gateway", modelId: "gateway" };

export interface CompleteRequest {
	// The number of this model request in the conversation. The first request is turn 1.
	turnNo: number;
	messages: ModelMessage[];
}

export type Complete = (request: CompleteRequest) => Promise<ModelAnswer>;

type JsonObject = Parameters<typeof fauxToolCall>[1];

function textOfParts(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") {
		return content;
	}
	return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

// The text of an answer of the model, without the tool calls.
export function answerText(message: AssistantMessage): string {
	return textOfParts(message.content);
}

// The gateway contract has messages with text only. An assistant message with tool calls and a tool result are JSON text.
function toModelMessage(message: Message): ModelMessage | undefined {
	switch (message.role) {
		case "system": {
			const sections = Object.values(message.sections ?? {}).filter((text) => typeof text === "string");
			const content = [textOfParts(message.content), ...sections].filter((text) => text !== "").join("\n\n");
			return content === "" ? undefined : { role: "system", content };
		}
		case "user":
			return { role: "user", content: textOfParts(message.content) };
		case "assistant": {
			const text = answerText(message);
			const toolCalls = message.content.flatMap((part) =>
				part.type === "toolCall" ? [{ id: part.id, name: part.name, input: part.arguments }] : [],
			);
			return { role: "assistant", content: toolCalls.length === 0 ? text : JSON.stringify({ text, toolCalls }) };
		}
		case "toolResult":
			return {
				role: "tool",
				content: JSON.stringify({
					toolCallId: message.toolCallId,
					tool: message.toolName,
					output: textOfParts(message.content),
					isError: message.isError,
				}),
			};
	}
}

function toAssistantMessage(answer: ModelAnswer): AssistantMessage {
	const parts = [
		...(answer.text === "" ? [] : [fauxText(answer.text)]),
		...answer.toolCalls.map((call) => fauxToolCall(call.name, call.input as JsonObject, { id: call.id })),
	];
	return fauxAssistantMessage(parts, { stopReason: answer.toolCalls.length === 0 ? "stop" : "toolUse" });
}

// The pi-ai models with the one gateway provider. The faux provider of pi-ai takes a function for each response.
// The function adds itself again, so the queue of responses never becomes empty.
export function gatewayModels(complete: Complete): Models {
	const faux = fauxProvider({ provider: GATEWAY_MODEL.provider, models: [{ id: GATEWAY_MODEL.modelId }] });
	const respond = async (context: { messages: Message[] }): Promise<AssistantMessage> => {
		faux.appendResponses([respond]);
		const messages = context.messages.flatMap((message) => toModelMessage(message) ?? []);
		const turnNo = context.messages.filter((message) => message.role === "assistant").length + 1;
		return toAssistantMessage(await complete({ turnNo, messages }));
	};
	faux.setResponses([respond]);
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}
