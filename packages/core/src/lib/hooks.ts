// The hook points of the loop (docs/ARCHITECTURE.md, section 4.1). They are cordis events.
// A listener of "tool/before" or "answer/check" can refuse: it returns the text of the refusal.

export interface HookPoints {
	"task/start": (info: { taskId: string }) => void;
	"attempt/start": (info: { taskId: string; attemptNo: number }) => void;
	"model/before": (info: { taskId: string; attemptNo: number }) => void;
	"tool/before": (info: { taskId: string; toolCallId: string; tool: string }) => string | undefined;
	"tool/after": (info: { taskId: string; toolCallId: string; tool: string }) => void;
	"turn/end": (info: { taskId: string; attemptNo: number }) => void;
	"answer/check": (info: { taskId: string; text: string }) => string | undefined;
	"task/end": (info: { taskId: string; stop: string }) => void;
}

export type HookPoint = keyof HookPoints;

export const HOOK_POINTS: readonly HookPoint[] = [
	"task/start",
	"attempt/start",
	"model/before",
	"tool/before",
	"tool/after",
	"turn/end",
	"answer/check",
	"task/end",
];

declare module "cordis" {
	interface Events extends HookPoints {}
}
