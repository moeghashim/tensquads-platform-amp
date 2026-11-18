// Two test adapters of the model port: a script of answers, and an echo.
import { type ModelAnswer, type ModelRequest, type Plugin, ports } from "@tensquads/core";

// One answer of the script. Text, tool requests, an action request (a tool call to an action tool),
// a question to the owner and a wrong result all have this shape.
export interface ScriptedAnswer {
	text?: string;
	toolCalls?: readonly { name: string; input?: unknown }[];
}

// The test adapter counts characters as tokens.
function usage(request: ModelRequest, text: string): ModelAnswer["usage"] {
	const inputTokens = request.messages.reduce((sum, message) => sum + message.content.length, 0);
	return { inputTokens, outputTokens: text.length };
}

// Answers the requests in the order of the script. It throws an error when the script ends.
export function scriptedModel(script: readonly ScriptedAnswer[]): Plugin {
	return {
		name: "model-scripted",
		provides: [ports.model],
		needs: [],
		apply: (ctx) => {
			let next = 0;
			let calls = 0;
			ctx.provide(ports.model, {
				complete: async (request) => {
					const step = script[next];
					if (!step) {
						throw new Error(
							`The scripted model has no answer for request ${next + 1}. The script has ${script.length} answers.`,
						);
					}
					next += 1;
					const text = step.text ?? "";
					const toolCalls = (step.toolCalls ?? []).map((call) => {
						calls += 1;
						return { id: `call-${calls}`, name: call.name, input: call.input ?? {} };
					});
					return { text, toolCalls, provider: "test", model: "scripted", usage: usage(request, text) };
				},
			});
		},
	};
}

// Answers each request with the text of the last user message. It gives no tool calls.
export function echoModel(): Plugin {
	return {
		name: "model-echo",
		provides: [ports.model],
		needs: [],
		apply: (ctx) => {
			ctx.provide(ports.model, {
				complete: async (request) => {
					const text = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
					return { text, toolCalls: [], provider: "test", model: "echo", usage: usage(request, text) };
				},
			});
		},
	};
}
