// The tests by code of the check of a result (requirement K1, ARCHITECTURE section 4.1).
// A test gives the reason of a failure, or undefined when the result passes it.
import { testBot } from "@tensquads/bots";
import type { Brief, TaskResult } from "@tensquads/contracts";

// The forget list has the ids of the facts that the owner forgot during the task (decision D11).
export type CodeTest = (input: { brief: Brief; result: TaskResult; forget: readonly string[] }) => string | undefined;

// Each line of "done" that starts with "- " names one part that the result must have.
const PART = /^- (.+)$/gm;

// A result names a fact as "[fact:<id>]" in its answer, or as "fact/<id>" in its evidence.
const FACT_IN_ANSWER = /\[fact:([^\]\s]+)\]/g;
const FACT_IN_EVIDENCE = /^fact\/(.+)$/;

export const hasEachPart: CodeTest = ({ brief, result }) => {
	const answer = result.answer.toLowerCase();
	const missing = [...brief.done.matchAll(PART)]
		.map((match) => (match[1] ?? "").trim())
		.filter((part) => !answer.includes(part.toLowerCase()));
	return missing.length === 0 ? undefined : `The result has no part ${missing.map((part) => `"${part}"`).join(", ")}.`;
};

export const namesOnlyKnownFacts: CodeTest = ({ brief, result }) => {
	const known = new Set(brief.facts.map((fact) => fact.id));
	const named = [
		...[...result.answer.matchAll(FACT_IN_ANSWER)].map((match) => match[1] ?? ""),
		...result.evidence.flatMap((entry) => FACT_IN_EVIDENCE.exec(entry)?.[1] ?? []),
	];
	const unknown = [...new Set(named.filter((id) => !known.has(id)))];
	return unknown.length === 0
		? undefined
		: `The result names the fact ${unknown.map((id) => `"${id}"`).join(", ")}, which is not in the brief.`;
};

// The result must not use a fact on the forget list of the task (ARCHITECTURE section 4.5, requirement M9).
export const usesNoForgottenFact: CodeTest = ({ brief, result, forget }) => {
	const texts = [result.answer, ...result.evidence];
	const used = brief.facts.filter(
		(fact) => forget.includes(fact.id) && fact.text !== "" && texts.some((text) => text.includes(fact.text)),
	);
	return used.length === 0
		? undefined
		: `The result uses the forgotten fact ${used.map((fact) => `"${fact.id}"`).join(", ")}.`;
};

// The tests by code of each bot, by the id of the bot.
export const CODE_TESTS: Readonly<Record<string, readonly CodeTest[]>> = {
	[testBot.id]: [usesNoForgottenFact, hasEachPart, namesOnlyKnownFacts],
};
