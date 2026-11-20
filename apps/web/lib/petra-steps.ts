// The internal steps of Petra for one command, from GET /v1/commands/{commandId}/steps: her model calls, her tool
// runs, the decision rows and the cost rows. The activity panel shows each step one time, with the time of the step.

export type PetraStep =
	| {
			kind: "model";
			at: string;
			provider: string;
			model: string;
			ms: number;
			inputTokens: number;
			outputTokens: number;
			tools: string[];
			failed: boolean;
	  }
	| { kind: "tool"; at: string; tool: string; ms: number; failed: boolean }
	| {
			kind: "decision";
			at: string;
			point: string;
			decider: string;
			options: string[];
			answer: string | null;
			probability: number | null;
			used: boolean;
			shadow: boolean;
			ms: number | null;
	  }
	| {
			kind: "cost";
			at: string;
			costKind: string;
			provider: string;
			model: string;
			units: number;
			unit: string;
			// In millionths of a US dollar.
			amount: number;
	  };

export interface StepLine {
	kind: PetraStep["kind"];
	at: string;
	text: string;
}

type Of<K extends PetraStep["kind"]> = Extract<PetraStep, { kind: K }>;

function decisionText(step: Of<"decision">): string {
	const options = step.options.length > 0 ? ` [${step.options.join(" | ")}]` : "";
	const probability = step.probability === null ? "" : ` p=${step.probability}`;
	const ms = step.ms === null ? "" : ` · ${step.ms} ms`;
	const note = step.shadow ? " (shadow)" : step.used || step.probability === null ? "" : " (not used)";
	return `decider ${step.decider} · ${step.point}${options} → ${step.answer ?? "no answer"}${probability}${ms}${note}`;
}

const TEXT: { [K in PetraStep["kind"]]: (step: Of<K>) => string } = {
	model: (step) => {
		const name = `petra model ${step.provider}/${step.model}`;
		if (step.failed) return `${name} failed after ${step.ms} ms`;
		const chose = step.tools.length > 0 ? step.tools.join(", ") : "text";
		return `${name} ${step.ms} ms · ${step.inputTokens} in / ${step.outputTokens} out tokens → ${chose}`;
	},
	tool: (step) => `petra tool ${step.tool} ${step.ms} ms${step.failed ? " failed" : ""}`,
	decision: decisionText,
	cost: (step) => {
		const model = step.model ? `/${step.model}` : "";
		const dollars = (step.amount / 1_000_000).toFixed(6);
		return `cost ${step.costKind} ${step.provider}${model} ${step.units} × ${step.unit} = $${dollars}`;
	},
};

export function stepLine(step: PetraStep): StepLine {
	const text = (TEXT[step.kind] as (item: PetraStep) => string)(step);
	return { kind: step.kind, at: step.at.slice(11, 23), text };
}

// The commands that the page reads: the steps it showed, and the last time a new step came.
export type StepWatch = Map<string, { shown: Set<string>; lastNew: number }>;

// The page stops reading a command when no new step came for this time.
const QUIET_MS = 30_000;

export function watchCommand(watch: StepWatch, commandId: string, now: number): void {
	if (!watch.has(commandId)) watch.set(commandId, { shown: new Set(), lastNew: now });
}

// The commands to read now. A command that is quiet leaves the watch.
export function watchedCommands(watch: StepWatch, now: number): string[] {
	for (const [commandId, entry] of watch) {
		if (now - entry.lastNew > QUIET_MS) watch.delete(commandId);
	}
	return [...watch.keys()];
}

// The lines of the steps that the page did not show. A later read can sort a new row before an old one, so the page
// compares whole steps, not positions.
export function stepUpdate(watch: StepWatch, commandId: string, steps: readonly PetraStep[], now: number): StepLine[] {
	const entry = watch.get(commandId);
	if (!entry) return [];
	const fresh = steps.filter((step) => !entry.shown.has(JSON.stringify(step)));
	for (const step of fresh) entry.shown.add(JSON.stringify(step));
	if (fresh.length > 0) entry.lastNew = now;
	return fresh.map(stepLine);
}
