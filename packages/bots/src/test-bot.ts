import { type BotDefinition, botDefinition } from "@tensquads/contracts";

// The parse checks the data. A wrong definition fails at import.
export const testBot: BotDefinition = botDefinition.parse({
	id: "test-bot",
	version: "0.2.0",
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
		// Changes a file of the work directory. The loop sends the file to the draft store (requirement G11).
		{ name: "append_file", kind: "compute", replay: "safe" },
		{ name: "send_reply", kind: "action", actionKind: "public" },
		{ name: "refund", kind: "action", actionKind: "money" },
	],
	readList: ["memory/core", "memory/facts"],
	factPages: ["customers"],
});
