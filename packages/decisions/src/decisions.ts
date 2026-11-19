// The decision sequence of one ask (docs/ARCHITECTURE.md, sections 4.6 and 4.7, requirements Q2 to Q5).
// The decider reads, and the code decides: our code compares the probability with the level of the point.
// Each answer is one record. A record with the same key is read first, so a second run does not ask again.
import type { CallUsage, Decider, DeciderAnswer, DeciderQuestion, DecisionRecord } from "@tensquads/core";

import { OPTIONS_OF_ASK, type PointId, pointOf } from "./points.js";

// One question about one message. The text of the message goes to the decider, never to the record (Q3).
export interface DecisionAsk {
	// The key of the record, from its cause (section 7.1). For example "cmd/{commandId}/request-clear".
	sourceRef: string;
	point: PointId;
	taskId: string | null;
	// The seq of the message that the question is about, or null when it has no row.
	messageSeq: number | null;
	message: string;
	// The options of a choice point.
	options?: readonly string[];
	// The words of the rule of the owner, for the point "is the reason in the rule".
	rule?: string;
}

// The account writer of Petra gives this store (requirement P2). A row that is there does not change.
export interface DecisionStore {
	decisionRow(sourceRef: string, decider: string): Promise<DecisionRecord | undefined>;
	addDecision(row: DecisionRecord): Promise<void>;
}

// The costs (packages/costs). This package does not import them (C2).
export interface DecisionCosts {
	usage(ref: { cause: string; taskId: string | null }, kind: "decider", usage: readonly CallUsage[]): Promise<void>;
}

export type Why = "sure" | "below the level" | "not valid" | "error" | "timeout";

export interface Verdict {
	sourceRef: string;
	point: PointId;
	// The answer of the decider. Use it only when "sure" is true.
	answer: string | null;
	probability: number | null;
	sure: boolean;
	why: Why;
}

export interface DecisionsDeps {
	store: DecisionStore;
	decider: Decider;
	// The second decider of the shadow mode, or null (requirement Q5).
	shadow: Decider | null;
	// After this time, the answer is "not sure" (the setting DECIDER_TIMEOUT_MS).
	timeoutMs: number;
	now: () => string;
	// One cost row for each usage of a decider call. The key has the cause of the ask (section 7.1).
	costs?: DecisionCosts;
}

export interface Decisions {
	// One call to the decider for all the asks that have no record (requirement Q2).
	ask(asks: readonly DecisionAsk[]): Promise<Verdict[]>;
}

const TIMEOUT = Symbol("timeout");

function optionsOf(ask: DecisionAsk): readonly string[] {
	const point = pointOf(ask.point);
	if (point.options !== OPTIONS_OF_ASK) return point.options;
	if (!ask.options || ask.options.length === 0) {
		throw new Error(`The choice point "${ask.point}" needs its options in the ask.`);
	}
	return ask.options;
}

function questionOf(ask: DecisionAsk): DeciderQuestion {
	const point = pointOf(ask.point);
	const rule = ask.rule === undefined ? [] : [`Rule: ${ask.rule}`];
	return {
		id: ask.sourceRef,
		point: ask.point,
		type: point.type,
		text: [point.question, ...rule, `Message: ${ask.message}`].join("\n"),
		options: optionsOf(ask),
	};
}

// A score is a number from 0 to 1, written as text. Each other answer is one of the options.
function validAnswer(type: DeciderQuestion["type"], options: readonly string[], answer: string): boolean {
	if (type !== "score") return options.includes(answer);
	const score = Number(answer);
	return answer.trim() !== "" && score >= 0 && score <= 1;
}

// Our code compares the answer with the options and the level of the point.
function judge(ask: DecisionAsk, answer: string | null, probability: number | null): Why {
	const point = pointOf(ask.point);
	if (answer === null || probability === null) return "error";
	if (!validAnswer(point.type, optionsOf(ask), answer) || !(probability >= 0 && probability <= 1)) return "not valid";
	return probability >= point.level ? "sure" : "below the level";
}

const verdictOf = (ask: DecisionAsk, answer: string | null, probability: number | null, why: Why): Verdict => ({
	sourceRef: ask.sourceRef,
	point: ask.point,
	answer,
	probability,
	sure: why === "sure",
	why,
});

type CallResult = { answers: DeciderAnswer[] } | { failed: "error" | "timeout" };

// One call with a time limit. An error or a timeout gives no answer. It never throws.
async function callDecider(decider: Decider, questions: readonly DeciderQuestion[], timeoutMs: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<typeof TIMEOUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
	});
	const started = Date.now();
	try {
		const answers = await Promise.race([decider.ask(questions), limit]);
		const result: CallResult = answers === TIMEOUT ? { failed: "timeout" } : { answers };
		return { result, ms: Date.now() - started };
	} catch {
		return { result: { failed: "error" } satisfies CallResult, ms: Date.now() - started };
	} finally {
		clearTimeout(timer);
	}
}

export function decisions(deps: DecisionsDeps): Decisions {
	const { store, decider, shadow } = deps;
	if (shadow && shadow.name === decider.name) {
		throw new Error(`The shadow decider needs a different name from the decider "${decider.name}".`);
	}

	// One record for one answer. The system never uses an answer of the shadow, or one that is not sure (Q4, Q5).
	function recordOf(who: Decider, verdict: Verdict, ask: DecisionAsk, ms: number, isShadow: boolean): DecisionRecord {
		const { probability } = verdict;
		return {
			sourceRef: ask.sourceRef,
			decider: who.name,
			taskId: ask.taskId,
			point: ask.point,
			messageSeq: ask.messageSeq,
			options: optionsOf(ask),
			answer: verdict.answer,
			probability: probability !== null && probability >= 0 && probability <= 1 ? probability : null,
			shadow: isShadow,
			used: !isShadow && verdict.sure,
			ms,
			at: deps.now(),
		};
	}

	// The cause of an ask is its key without the point: "cmd/{commandId}" or "action/{taskId}/{toolCallId}".
	async function costOf(missing: readonly DecisionAsk[], result: CallResult): Promise<void> {
		const usage = "answers" in result ? result.answers.find((answer) => answer.usage)?.usage : undefined;
		const [first] = missing;
		if (!usage || !first || !deps.costs) return;
		const cause = first.sourceRef.slice(0, first.sourceRef.lastIndexOf("/"));
		await deps.costs.usage({ cause, taskId: first.taskId }, "decider", usage);
	}

	// One call for the asks that have no record. It writes one record for each answer.
	async function askMissing(who: Decider, missing: readonly DecisionAsk[], isShadow: boolean) {
		const fresh = new Map<string, Verdict>();
		if (missing.length === 0) return fresh;
		const { result, ms } = await callDecider(who, missing.map(questionOf), deps.timeoutMs);
		await costOf(missing, result);
		for (const ask of missing) {
			const found = "answers" in result ? result.answers.find((item) => item.id === ask.sourceRef) : undefined;
			const answer = found?.answer ?? null;
			const probability = found?.probability ?? null;
			const why = "failed" in result ? result.failed : judge(ask, answer, probability);
			const verdict = verdictOf(ask, answer, probability, why);
			fresh.set(ask.sourceRef, verdict);
			await store.addDecision(recordOf(who, verdict, ask, ms, isShadow));
		}
		return fresh;
	}

	// A record with the same key gives its answer again, so a second run does not ask (section 4.6).
	async function askAndRecord(who: Decider, asks: readonly DecisionAsk[], isShadow: boolean): Promise<Verdict[]> {
		const known = await Promise.all(asks.map((ask) => store.decisionRow(ask.sourceRef, who.name)));
		const fresh = await askMissing(
			who,
			asks.filter((_ask, index) => known[index] === undefined),
			isShadow,
		);
		return asks.map((ask, index) => {
			const row = known[index];
			if (!row) return fresh.get(ask.sourceRef) as Verdict;
			return verdictOf(ask, row.answer, row.probability, judge(ask, row.answer, row.probability));
		});
	}

	return {
		async ask(asks) {
			// Each choice point has its options before a call starts.
			for (const ask of asks) optionsOf(ask);
			const [verdicts] = await Promise.all([
				askAndRecord(decider, asks, false),
				shadow ? askAndRecord(shadow, asks, true) : Promise.resolve([]),
			]);
			return verdicts;
		},
	};
}
