// The model requests of the loop of Petra (task 12). The code adds her instructions and the language of the answer
// (requirement N9), writes the cost rows of each call (requirement N4), and puts the command id, the channel and the
// text of the current command in the input of each tool. The model never selects the command or the channel.
// The model port of Petra has the time limit and the second try (limitedModel, requirement N6). The plug-in list
// puts them on the port, so the loop, the decider and the night job each get them one time.
import type { Model, ModelAnswer, ModelMessage, ModelToolCall, ModelToolDefinition } from "@tensquads/core";

import type { RunStep, StepLog } from "./command-steps.js";
import { petraInstructions } from "./instructions.js";
import { answerLanguage, type Language, languageInstruction } from "./language.js";
import { type CommandCosts, type ConversationInput, conversationInput } from "./petra.js";
import { isTaskBot, MODEL_TEXT_TOOLS, PETRA_TOOLS, TASK_BOTS } from "./petra-tools.js";

export interface PetraCompletionDeps {
	// The model port of Petra, with its time limit and its second try (limitedModel).
	model: Model;
	tools: readonly ModelToolDefinition[];
	costs: Pick<CommandCosts, "modelCall">;
	// Each model call of a command is one step for the owner (GET /v1/commands/{commandId}/steps).
	steps: Pick<StepLog, "add">;
	// The language of the account, for a message that has no Latin and no Arabic letters.
	accountLanguage: Language;
	log: (line: string) => void;
	// The texts of the active core items of the memory. Each command turn has them in the instructions (decision of
	// Moe, 2026-11-20). With no function, the instructions have no core.
	core?: () => Promise<readonly string[]>;
}

// The part of the instructions with the core of the memory. An empty core gives no part.
function coreText(core: readonly string[]): string {
	return core.length === 0
		? ""
		: `\n\nWhat you know about this business:\n${core.map((text) => `- ${text}`).join("\n")}`;
}

// The fixed message when the model fails two times (requirement N6). The message of the owner stays in the database.
export const MODEL_FAILED_TEXT: Record<Language, string> = {
	en: "I cannot answer now, because my model did not answer. Your message is saved. Please send it again later.",
	ar: "لا أستطيع أن أجيب الآن، لأن النموذج لم يجب. رسالتك محفوظة. من فضلك أرسلها مرة أخرى لاحقا.",
};

// Each call gets one more try (requirement N6).
const TRIES = 2;

// The cause of the cost rows of a turn with no command: the history of a new conversation (section 7.1).
const HISTORY_CAUSE = "history";

class ModelTimeout extends Error {
	override name = "ModelTimeout";
}

// One call with a time limit. The signal stops the request. The race stops the wait if the adapter ignores the signal.
async function callWithLimit(model: Model, request: Parameters<Model["complete"]>[0], ms: number) {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new ModelTimeout(`The model call took longer than ${ms} ms.`));
		}, ms);
	});
	try {
		return await Promise.race([model.complete({ ...request, signal: controller.signal }), late]);
	} finally {
		clearTimeout(timer);
	}
}

// The model port with a time limit for each call and one more try after a failure or a timeout (requirement N6).
// It throws when both calls fail. Each failure is one log line. The error of the adapter has no key (N3).
export function limitedModel(model: Model, options: { timeoutMs: number; log: (line: string) => void }): Model {
	return {
		...(model.id ? { id: model.id } : {}),
		async complete(request) {
			for (let attempt = 1; attempt <= TRIES; attempt += 1) {
				try {
					return await callWithLimit(model, request, options.timeoutMs);
				} catch (error) {
					const { name, message } = error instanceof Error ? error : new Error("unknown");
					options.log(`petra: model call ${attempt} of ${TRIES} failed: ${name}: ${message}`);
				}
			}
			throw new Error(`The model call failed ${TRIES} times.`);
		},
	};
}

// The input of a tool comes from the current command. Only the text of a tool that answers or asks the owner comes
// from the model. When the model gives no text to such a tool, the owner gets the fixed message, never an echo of
// the owner message.
function toolInput(call: ModelToolCall, input: ConversationInput, language: Language): Record<string, unknown> {
	const { commandId, channel } = input;
	if (call.name === PETRA_TOOLS.startTask) {
		// The model can name a bot of the squad. Each other field comes from the command (requirement N5).
		const { bot } = (call.input ?? {}) as { bot?: unknown };
		const known = typeof bot === "string" && isTaskBot(bot);
		return { commandId, channel, text: input.text, ...(known ? { bot } : {}) };
	}
	if (!MODEL_TEXT_TOOLS.has(call.name)) return { commandId, channel, text: input.text };
	const given = (call.input ?? {}) as { text?: unknown };
	const own = typeof given.text === "string" && given.text.trim() !== "";
	return { commandId, channel, text: own ? given.text : MODEL_FAILED_TEXT[language] };
}

// An answer with no model call: the fixed message, or the end of a turn whose command has its tool.
function codeAnswer(text: string, toolCalls: ModelToolCall[]): ModelAnswer {
	const usage = { inputTokens: 0, outputTokens: 0 };
	return { text, toolCalls, requestId: "petra-code", provider: "petra", model: "code", usage };
}

const answerCall = (input: ConversationInput, id: string, text: string): ModelToolCall => ({
	id: `${input.commandId}/${id}`,
	name: PETRA_TOOLS.answerOwner,
	input: { commandId: input.commandId, channel: input.channel, text },
});

// The answer that the loop gets. A text with no tool call, before the command has its tool, goes to the owner with
// the tool "answer the owner". Thus each command ends with a tool, and gets the status "done".
// A turn with no command (the history of a new conversation) runs no tool: its tool calls are dropped (N5).
function shape(answer: ModelAnswer | undefined, input: ConversationInput | undefined, language: Language): ModelAnswer {
	if (!input) return answer ? { ...answer, toolCalls: [] } : codeAnswer("", []);
	if (answer && answer.toolCalls.length > 0) {
		const toolCalls = answer.toolCalls.map((call) => ({ ...call, input: toolInput(call, input, language) }));
		return { ...answer, toolCalls };
	}
	if (input.handled) return answer ?? codeAnswer("", []);
	if (answer && answer.text.trim() !== "") return { ...answer, toolCalls: [answerCall(input, "answer", answer.text)] };
	return codeAnswer("", [answerCall(input, "model-failed", MODEL_FAILED_TEXT[language])]);
}

export function petraCompletion(
	deps: PetraCompletionDeps,
): (request: { messages: ModelMessage[] }) => Promise<ModelAnswer> {
	const instructions = petraInstructions(TASK_BOTS);
	const tools = deps.tools.map((tool) => tool.name);

	// One call of the limited port. The cost write comes after the call and outside the try, so an error of the
	// cost write never causes a second paid call.
	async function call(messages: ModelMessage[], input: ConversationInput | undefined) {
		const started = Date.now();
		let answer: ModelAnswer | undefined;
		try {
			answer = await deps.model.complete({ messages, tools, toolDefinitions: deps.tools });
		} catch {
			// The limited port wrote a log line for each failure.
		}
		// A model call in a command has the key of the command. A turn with no command has the cause "history"
		// (section 7.1, requirement N4).
		const cause = input ? `cmd/${input.commandId}` : HISTORY_CAUSE;
		if (answer) await deps.costs.modelCall({ cause, taskId: null }, answer);
		if (input) await deps.steps.add(input.commandId, modelStep(started, answer));
		return answer;
	}

	// The step of one call. The time includes the second try. A failed call has the names of the port and no tokens.
	function modelStep(started: number, answer: ModelAnswer | undefined): RunStep {
		const base = { kind: "model" as const, at: new Date(started).toISOString(), ms: Date.now() - started };
		if (!answer) {
			const { provider, model } = deps.model.id ?? { provider: "unknown", model: "unknown" };
			return { ...base, provider, model, inputTokens: 0, outputTokens: 0, tools: [], failed: true };
		}
		const { provider, model, usage, toolCalls } = answer;
		const { inputTokens, outputTokens } = usage;
		const tools = toolCalls.map((item) => item.name);
		return { ...base, provider, model, inputTokens, outputTokens, tools, failed: false };
	}

	return async ({ messages }) => {
		const input = conversationInput(messages);
		// The tool of the command ran and answered the owner. A model call now only adds time and cost, so the code
		// ends the turn. The next command of the owner then starts sooner.
		if (input?.handled) {
			deps.log(`petra: turn ended ${input.commandId}`);
			return codeAnswer("", []);
		}
		const language = answerLanguage(input?.text ?? "", deps.accountLanguage);
		const core = input && deps.core ? coreText(await deps.core()) : "";
		const content = `${instructions}${core}\n\n${languageInstruction(language)}`;
		const system: ModelMessage = { role: "system", content };
		const answer = shape(await call([system, ...messages], input), input, language);
		// An answer with no tool call ends the turn of Petra. Its cost rows are written. The runner of evals reads
		// this line, because the command is done before this last model call (task 11).
		if (input && answer.toolCalls.length === 0) deps.log(`petra: turn ended ${input.commandId}`);
		return answer;
	};
}
