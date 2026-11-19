// The level of each decision point (requirement Q1, build item 5). An answer is "sure" at or above its level.
// The first value is 0.90 for each yes or no point and for each choice point. Moe confirms the values in the pull request.
// This is the only file with the levels. Change a level here, and nowhere else.
export const LEVELS = {
	"which-bot": 0.9,
	"request-clear": 0.9,
	"refund-request": 0.9,
	"reason-in-rule": 0.9,
	"message-safe": 0.9,
	"message-for-task": 0.9,
} as const;
