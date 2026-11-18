// The rule model: the test adapter of the model port for Petra in task 04.
// A message of the owner to Petra starts with "[command {id} on {channel}]" (packages/petra, conversationText).
// For such a message, the model selects one tool of Petra by a rule. The tool gets the command id, the channel
// and the text. Each other request, for example of a bot, gets the text of the last user message, as the echo model.
import type { ModelAnswer, ModelRequest, Plugin } from "@tensquads/core";
import { ports } from "@tensquads/core";

const COMMAND = /^\[command (\S+) on (\S+)\] ([\s\S]*)$/;

// The script of a bot task, from the goal of its brief. "read N files" makes N turns, each with one
// read_file call. "ask" first calls ask_question. The last answer repeats each message of the owner that the
// bot got after the brief, so a test can count it (requirement L3).
const GOAL = /^Goal: (.*)$/m;

function botAnswer(request: ModelRequest, goal: string): ModelAnswer {
	const results = request.messages.filter((message) => message.role === "tool");
	const reads = Number(/\bread (\d+) files?\b/i.exec(goal)?.[1] ?? 0);
	const asks = /\bask\b/i.test(goal) ? 1 : 0;
	const step = results.length + 1;
	if (step <= asks) {
		return answer(request, "", [{ id: `call-${step}`, name: "ask_question", input: { text: "Which day?" } }]);
	}
	if (step <= asks + reads) {
		return answer(request, "", [{ id: `call-${step}`, name: "read_file", input: { path: "shop/hours.txt" } }]);
	}
	const users = request.messages.filter((message) => message.role === "user").slice(1);
	const outputs = results.map((message) => (JSON.parse(message.content) as { output: string }).output);
	return answer(request, [`Result: ${goal}`, ...users.map((m) => `Message: ${m.content}`), ...outputs].join("\n"));
}

// "stop" stops a task. A status question tells the status. Each other message goes to "start a task".
// The tool "start a task" puts a message for a task that runs in the inbox of that task.
function toolOf(text: string): string {
	if (/\bstop\b/i.test(text)) return "stop_task";
	if (/\bstatus\b/i.test(text)) return "task_status";
	return "start_task";
}

function answer(request: ModelRequest, text: string, toolCalls: ModelAnswer["toolCalls"] = []): ModelAnswer {
	const inputTokens = request.messages.reduce((sum, message) => sum + message.content.length, 0);
	return { text, toolCalls, provider: "test", model: "rule", usage: { inputTokens, outputTokens: text.length } };
}

// An answer to Petra. After the tool result, the turn ends with a text and no tool.
function petraAnswer(request: ModelRequest): ModelAnswer {
	if (request.messages.at(-1)?.role === "tool") return answer(request, "Done.");
	const text = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
	const match = COMMAND.exec(text);
	if (!match) return answer(request, text);
	const [, commandId = "", channel = "", body = ""] = match;
	const call = { id: `${commandId}/tool`, name: toolOf(body), input: { commandId, channel, text: body } };
	return answer(request, "", [call]);
}

export function ruleModel(): Plugin {
	return {
		name: "model-rule",
		provides: [ports.model],
		needs: [],
		apply: (ctx) => {
			ctx.provide(ports.model, {
				complete: async (request) => {
					const goal = GOAL.exec(request.messages.find((message) => message.role === "user")?.content ?? "");
					return goal?.[1] === undefined ? petraAnswer(request) : botAnswer(request, goal[1]);
				},
			});
		},
	};
}
