import { type BotDefinition, botDefinition } from "@tensquads/contracts";

// The parse checks the data. A wrong definition fails at import.
export const testBot: BotDefinition = botDefinition.parse({
	id: "test-bot",
	version: "0.1.0",
	taskTypes: [
		{
			name: "answer-question",
			price: 1,
			limits: { maxTurns: 10, maxBudget: 0.5 },
		},
	],
	tools: [
		{ name: "read_file", kind: "read", replay: "safe" },
		{ name: "calculate", kind: "compute", replay: "safe" },
		{ name: "send_reply", kind: "action", actionKind: "public" },
		{ name: "refund", kind: "action", actionKind: "money" },
	],
	readList: ["memory/core", "memory/facts"],
	factPages: ["customers"],
});
