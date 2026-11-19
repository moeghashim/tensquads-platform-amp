import type { Message } from "@earendil-works/pi-ai";
import type { Brief } from "@tensquads/contracts";
import type { ModelMessage } from "@tensquads/core";

// The brief is the first input of a task (requirement L1). Each fact is on its own line with the id of its row.
export function renderBrief(brief: Brief): string {
	const facts = brief.facts.map((fact) => `- [${fact.id}] ${fact.text}`);
	const notInTask = brief.notInTask.map((item) => `- ${item}`);
	return [
		`Goal: ${brief.goal}`,
		`Done: ${brief.done}`,
		"Facts:",
		...facts,
		`Limits: at most ${brief.limits.maxTurns} turns, a budget of ${brief.limits.maxBudget} US dollars.`,
		"Not in the task:",
		...notInTask,
		`Reply to: ${brief.replyTo}`,
	].join("\n");
}

const REMOVED = "[removed]";

function clean(text: string, texts: readonly string[]): string {
	return texts.reduce((value, forgotten) => value.split(forgotten).join(REMOVED), text);
}

function cleanParts<P extends { type: string }>(parts: readonly P[], texts: readonly string[]): P[] {
	return parts.map((part) =>
		part.type === "text" && "text" in part && typeof part.text === "string"
			? { ...part, text: clean(part.text, texts) }
			: part,
	);
}

// Removes each exact copy of a forgotten text from the messages (ARCHITECTURE section 4.5).
export function removeTexts(messages: readonly Message[], texts: readonly string[]): Message[] {
	const nonEmpty = texts.filter((text) => text !== "");
	if (nonEmpty.length === 0) {
		return [...messages];
	}
	return messages.map((message) => cleanMessage(message, nonEmpty));
}

// Removes each exact copy of a forgotten text from the model messages of Petra (ARCHITECTURE section 4.6).
export function removeModelTexts(messages: readonly ModelMessage[], texts: readonly string[]): ModelMessage[] {
	const nonEmpty = texts.filter((text) => text !== "");
	return messages.map((message) => ({ ...message, content: clean(message.content, nonEmpty) }));
}

function cleanMessage(message: Message, texts: readonly string[]): Message {
	if (message.role === "assistant") {
		return { ...message, content: cleanParts(message.content, texts) };
	}
	if (message.role === "toolResult") {
		return { ...message, content: cleanParts(message.content, texts) } as Message;
	}
	return typeof message.content === "string"
		? { ...message, content: clean(message.content, texts) }
		: ({ ...message, content: cleanParts(message.content, texts) } as Message);
}
