// The list of decision points (docs/ARCHITECTURE.md, section 4.7, requirement Q1).
// Each point is one row: its id, its question, its type, its options, the harm if the answer is wrong,
// its level, and the path below the level. Do not add a point without Moe (task 09, "Stop and ask").
import type { DeciderQuestionType } from "@tensquads/core";

import { LEVELS } from "./levels.js";

export type PointId = keyof typeof LEVELS;

// The options of a choice point come from the ask: for example the ids of the bots or of the tasks that run.
export const OPTIONS_OF_ASK = "given by the ask";

export interface DecisionPoint {
	id: PointId;
	question: string;
	type: DeciderQuestionType;
	options: readonly string[] | typeof OPTIONS_OF_ASK;
	// What goes wrong if the answer is wrong.
	harm: string;
	// The answer is "sure" at or above this probability.
	level: number;
	// What occurs below the level, or after an answer that is not valid, an error or a timeout (requirement Q4).
	below: string;
}

const YES_NO = ["yes", "no"] as const;

export const POINTS: readonly DecisionPoint[] = [
	{
		id: "which-bot",
		question: "Which bot does this task?",
		type: "choice",
		options: OPTIONS_OF_ASK,
		harm: "The wrong bot does the task, and the owner pays for a task that does not help.",
		level: LEVELS["which-bot"],
		below: "Petra asks the owner which bot does the task. No task starts before the answer.",
	},
	{
		id: "request-clear",
		question: "Is the request clear?",
		type: "yes_no",
		options: YES_NO,
		harm: "A task starts on a guess, and the owner pays for it.",
		level: LEVELS["request-clear"],
		below: "Petra asks the owner one question. No task starts.",
	},
	{
		id: "refund-request",
		question: "Is this a refund request?",
		type: "yes_no",
		options: YES_NO,
		harm: "Money goes out for a message that does not ask for it.",
		level: LEVELS["refund-request"],
		below: "The gate asks the owner for an approval.",
	},
	{
		id: "reason-in-rule",
		question: "Is the reason in the rule?",
		type: "yes_no",
		options: YES_NO,
		harm: "A refund goes out for a reason that the rule of the owner does not accept.",
		level: LEVELS["reason-in-rule"],
		below: "The gate asks the owner for an approval.",
	},
	{
		id: "message-safe",
		question: "Is the message safe to send?",
		type: "yes_no",
		options: YES_NO,
		harm: "An abusive or false message gets money, and no person reads it.",
		level: LEVELS["message-safe"],
		below: "The gate asks the owner for an approval.",
	},
	{
		id: "message-for-task",
		question: "Is this message for a task that runs?",
		type: "choice",
		options: OPTIONS_OF_ASK,
		harm: "The message goes to the wrong task, or a second task starts for the work of a task that runs.",
		level: LEVELS["message-for-task"],
		below: "Petra asks the owner which task the message is for.",
	},
];

export function pointOf(id: PointId): DecisionPoint {
	const point = POINTS.find((item) => item.id === id);
	if (!point) throw new Error(`The decision point "${id}" is not in the list.`);
	return point;
}
