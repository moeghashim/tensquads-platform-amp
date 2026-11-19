// The rule model: the test adapter of the model port for Petra in task 04.
// A message of the owner to Petra starts with "[command {id} on {channel}]" (packages/petra, conversationText).
// For such a message, the model selects one tool of Petra by a rule. The tool gets the command id, the channel
// and the text. Each other request, for example of a bot, gets the text of the last user message, as the echo model.
import type { ModelAnswer, ModelRequest, Plugin } from "@tensquads/core";
import { ports } from "@tensquads/core";

const COMMAND = /^\[command (\S+) on (\S+)\] ([\s\S]*)$/;

// The script of a bot task, from the goal of its brief. "read N files" makes N turns, each with one
// read_file call. "ask" first calls ask_question. An action comes after them, in one turn:
// "refund 15 to cust-1" calls refund, and "reply hello to cust-1" calls send_reply (task 05).
// "refund 40 then 45 after a restart" asks for 40 the first time and for 45 each later time with the same
// tool-call id (requirement G8). "append 2 lines" makes 2 turns, each with one append_file call to notes.txt,
// then one read_file call of notes.txt (requirement G11). The last answer repeats each message of the owner that the bot got after the
// brief, so a test can count it (requirement L3). The goals "wrong then right" and "always wrong" mark answers
// wrong for the check (requirement K3).
const GOAL = /^Goal: (.*)$/m;
const REFUND = /\brefund (\d+(?:\.\d+)?)(?: then (\d+(?:\.\d+)?) after a restart)?(?: to (\S+))?/i;
const REPLY = /\breply (.+?) to (\S+)/i;

type ToolCall = ModelAnswer["toolCalls"][number];

// The number of times the model gave each tool call of each goal, in this instance of the model.
type Seen = Map<string, number>;

function actionCall(goal: string, id: string, seen: Seen): ToolCall | undefined {
	const reply = REPLY.exec(goal);
	if (reply) return { id, name: "send_reply", input: { to: reply[2], text: reply[1] } };
	const refund = REFUND.exec(goal);
	if (!refund) return undefined;
	const key = `${goal}\n${id}`;
	const times = seen.get(key) ?? 0;
	seen.set(key, times + 1);
	const amount = Number(times > 0 && refund[2] !== undefined ? refund[2] : refund[1]);
	return { id, name: "refund", input: { amount, to: refund[3] ?? "cust-1", currency: "USD" } };
}

// The append script: one line in each turn, then one read of the file.
function appendCall(step: number, appends: number): ToolCall | undefined {
	const id = `call-${step}`;
	if (step <= appends) return { id, name: "append_file", input: { path: "notes.txt", text: `line ${step}\n` } };
	return step === appends + 1 ? { id, name: "read_file", input: { path: "notes.txt" } } : undefined;
}

// The number in a goal, such as 3 in "read 3 files", or 0.
const countIn = (goal: string, pattern: RegExp) => Number(pattern.exec(goal)?.[1] ?? 0);

// The tool call of the step, or undefined after the last tool call of the script.
function scriptCall(goal: string, step: number, seen: Seen): ToolCall | undefined {
	const appends = countIn(goal, /\bappend (\d+) lines?\b/i);
	return appends > 0 ? appendCall(step, appends) : readCall(goal, step, seen);
}

// The read script: an optional question, N reads, then the action of the goal.
function readCall(goal: string, step: number, seen: Seen): ToolCall | undefined {
	const reads = countIn(goal, /\bread (\d+) files?\b/i);
	const asks = /\bask\b/i.test(goal) ? 1 : 0;
	const id = `call-${step}`;
	if (step <= asks) return { id, name: "ask_question", input: { text: "Which day?" } };
	if (step <= asks + reads) return { id, name: "read_file", input: { path: "shop/hours.txt" } };
	return step === asks + reads + 1 ? actionCall(goal, id, seen) : undefined;
}

function botAnswer(request: ModelRequest, goal: string, seen: Seen): ModelAnswer {
	const results = request.messages.filter((message) => message.role === "tool");
	const call = scriptCall(goal, results.length + 1, seen);
	if (call) return answer(request, "", [call]);
	const users = request.messages.filter((message) => message.role === "user").slice(1);
	const outputs = results.map((message) => (JSON.parse(message.content) as { output: string }).output);
	const lines = [`Result: ${goal}`, ...users.map((m) => `Message: ${m.content}`), ...outputs].join("\n");
	return answer(request, wrongNow(goal, request) ? `${WRONG}${lines}` : lines);
}

// "always wrong" marks each answer wrong. "wrong then right" marks only the first answer wrong (task 06).
// The rule checker fails an answer with this mark, so a test can see the loop continue after a failed check.
const WRONG = "WRONG: ";

function wrongNow(goal: string, request: ModelRequest): boolean {
	if (/\balways wrong\b/i.test(goal)) return true;
	if (!/\bwrong then right\b/i.test(goal)) return false;
	return !request.messages.some((message) => message.role === "assistant" && message.content.startsWith(WRONG));
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
			const seen: Seen = new Map();
			ctx.provide(ports.model, {
				complete: async (request) => {
					const goal = GOAL.exec(request.messages.find((message) => message.role === "user")?.content ?? "");
					return goal?.[1] === undefined ? petraAnswer(request) : botAnswer(request, goal[1], seen);
				},
			});
		},
	};
}
