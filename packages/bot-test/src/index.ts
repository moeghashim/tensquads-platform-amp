// The runner plug-in of the test bot: its definition, its instructions and its tools (ARCHITECTURE section 3.2).
// The definition comes from packages/bots, so Petra and the runner read the same version (requirement L13).
import { testBot } from "@tensquads/bots";
import type { BotDefinition } from "@tensquads/contracts";
import type { Plugin, PortKey } from "@tensquads/core";

import { appendFile, type BotTool, calculate, readFile } from "./tools.js";

export { appendFile, type BotTool, calculate, readFile, TEST_FILES } from "./tools.js";

// What a bot gives to the runner. It has no code for an action tool: the loop makes each one (requirement G1).
export interface RunnerBot {
	definition: BotDefinition;
	instructions: string;
	// The read tools and the compute tools of the bot, by name. Each one gets the work directory of the files.
	tools: Readonly<Record<string, BotTool>>;
}

// The key of the bot in the plug-in list of the runner.
export const botPort: PortKey<RunnerBot> = { name: "bot" };

export const TEST_BOT_INSTRUCTIONS = [
	"You are the test bot of tensquads.",
	"Answer the question of the brief.",
	"Use read_file to read a file of the shop or a file of the task. Use calculate for each calculation.",
	"Use append_file to add text at the end of a file of the task.",
	"If you need a fact or a choice from the owner, use ask_question.",
	"When you have the answer, give it as text with no tool request.",
].join("\n");

export const testBotRunner: RunnerBot = {
	definition: testBot,
	instructions: TEST_BOT_INSTRUCTIONS,
	tools: { read_file: readFile, calculate, append_file: appendFile },
};

// One row of the plug-in list of the runner. It gives the test bot to the runner.
export function testBotPlugin(): Plugin {
	return {
		name: "bot-test",
		provides: [botPort],
		needs: [],
		apply(ctx) {
			ctx.provide(botPort, testBotRunner);
		},
	};
}
