// The spike core. Two small cordis plug-ins and the hook points of the loop.
// Part A (the Worker) and part B (the runner) use this same file.
import { Context } from "cordis";

export const HOOK_POINTS = ["model/before", "tool/before", "tool/after", "turn/end", "answer/check"] as const;
export type HookPoint = (typeof HOOK_POINTS)[number];

declare module "cordis" {
	interface Events {
		"model/before"(info: { messages: number }): void;
		"tool/before"(info: { name: string; id: string }): string | undefined;
		"tool/after"(info: { name: string; id: string }): void;
		"turn/end"(info: { results: number }): void;
		"answer/check"(info: { text: string }): string | undefined;
	}
}

export interface Log {
	events: string[];
}

// Plug-in 1: it records each hook point that runs.
export function Recorder(ctx: Context, config: Log) {
	for (const point of HOOK_POINTS) {
		ctx.on(point, (info: unknown) => {
			config.events.push(`${point} ${JSON.stringify(info)}`);
			return undefined;
		});
	}
}

// Plug-in 2: it refuses the first answer that has the word "draft".
export function Checker(ctx: Context) {
	let refused = false;
	ctx.on("answer/check", (info) => {
		if (!refused && info.text.includes("draft")) {
			refused = true;
			return "The answer is a draft. Give the final answer.";
		}
		return undefined;
	});
}

// Starts a cordis core with the two plug-ins. The returned function removes them.
export async function startCore(log: Log): Promise<{ ctx: Context; stop: () => Promise<void> }> {
	const ctx = new Context();
	const recorder = await ctx.use(Recorder, log);
	const checker = await ctx.use(Checker);
	return {
		ctx,
		stop: async () => {
			await checker.dispose();
			await recorder.dispose();
		},
	};
}
