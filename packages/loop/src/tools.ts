import { defineSignal, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj, str, unknown } from "@earendil-works/pi-schema";
import type { ActionAnswer } from "@tensquads/contracts";

import type { Link } from "./link.js";

// The tools that the loop gives to pi-durable: the tools of the bot, the tool "ask a question" and the action tools.

// The tool "ask a question". It parks until the answer arrives as a signal (requirement L6).
export const QUESTION_TOOL = "ask_question";

// The signal kind of a decision of the owner. The key is the id of the question or of the action.
export const ANSWER_SIGNAL = defineSignal({ name: "tensquads.answer", version: 1, schema: unknown() });

// A tool that runs in the sandbox. It gets the input of the model and the directory of the files of the bot.
// It returns the text for the model.
export type ToolExecute = (input: Record<string, unknown>, filesDir: string) => Promise<string>;

function textOutput(text: string) {
	return [{ type: "text" as const, text }];
}

export function botTool(name: string, execute: ToolExecute, filesDir: string): ToolRegistration {
	return defineTool({
		name,
		description: `The tool ${name} of the bot.`,
		parameters: obj({}, { open: true }),
		replay: "safe",
		async execute(args) {
			return { output: textOutput(await execute(args as Record<string, unknown>, filesDir)) };
		},
	});
}

export const questionTool = defineTool({
	name: QUESTION_TOOL,
	description: "Ask the owner a question. The answer comes back as the result of this tool.",
	parameters: obj({ text: str() }),
	replay: "safe",
	async execute(_args, api, ctx) {
		const signal = await api.readSignal(ANSWER_SIGNAL, api.callId, ctx);
		if (signal !== undefined && "value" in signal) {
			const text = typeof signal.value === "string" ? signal.value : JSON.stringify(signal.value);
			return { output: textOutput(text) };
		}
		return { sleep: { signals: [ANSWER_SIGNAL.key(api.callId)] } };
	},
});

export interface ActionToolDeps {
	link: Link;
	// Sends a copy of the journal to `journal`.
	saveCopy: () => Promise<void>;
	// Keeps an error for the end of the run. The run then stops.
	fail: (error: unknown) => void;
}

function answerText(answer: unknown): string {
	return typeof answer === "string" ? answer : JSON.stringify(answer);
}

async function askGate(name: string, args: Record<string, unknown>, callId: string, deps: ActionToolDeps) {
	try {
		// The copy comes first. Thus a new attempt always finds this tool call with the same id (requirement G5).
		await deps.saveCopy();
		return await deps.link.action({ toolCallId: callId, tool: name, content: args });
	} catch (error) {
		deps.fail(error);
		throw error;
	}
}

// An action tool (requirement G1, decision D8). Its code is one call to `journal` and one call to `action`.
// It never calls a service. It is declared replay "safe": after a stop or a park, pi-durable runs it again
// with the same tool-call id, and the gate gives the saved answer.
export function actionTool(name: string, deps: ActionToolDeps): ToolRegistration {
	return defineTool({
		name,
		description: `The action ${name}. The gate on Cloudflare does it.`,
		parameters: obj({}, { open: true }),
		replay: "safe",
		async execute(args, api, ctx) {
			const decided = (await api.readSignal(ANSWER_SIGNAL, api.callId, ctx)) !== undefined;
			const answer: ActionAnswer = await askGate(name, args as Record<string, unknown>, api.callId, deps);
			if (answer.status === "done") {
				return { output: textOutput(answerText(answer.answer)) };
			}
			if (answer.status === "refused") {
				// A refusal goes to the model as the result, and the loop continues (requirement G10).
				return { output: textOutput(answer.reason), isError: true };
			}
			if (decided) {
				// The decision of the owner came, but the gate still waits. "Wait" never goes to the model.
				const error = new Error(`The gate answered "wait" for the action ${api.callId} after the decision.`);
				deps.fail(error);
				throw error;
			}
			// The tool parks on a signal whose key is the id of the action (section 4.4).
			return { sleep: { signals: [ANSWER_SIGNAL.key(api.callId)] } };
		},
	});
}
