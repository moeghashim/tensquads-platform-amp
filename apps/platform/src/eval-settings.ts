// The settings of an eval Worker (task 11). This file has no type of Cloudflare, so the Node tests can import it.
import { RULE_SCRIPTS, type RuleScript } from "@tensquads/adapters-test";
import type { SendOutcome } from "@tensquads/core";

// A setting that is missing or not valid. The message names the setting, never its value (section 10).
export class SettingError extends Error {
	override name = "SettingError";
}

// The vars of the eval settings, as in wrangler.jsonc. Each default keeps the behaviour before task 11.
export interface EvalVars {
	NO_OUTGOING_ACTION?: string;
	EVAL_OWNERS?: string;
	CHANNEL_OUTCOME?: string;
	PAYMENT_OUTCOME?: string;
	FIXED_DECIDER_POINTS?: string;
	TEST_MODEL_SCRIPT?: string;
	// Only for the tests of the full path: each answer of the rule model waits this long. The default is 0.
	MODEL_HOLD_MS?: string;
}

// The answer of the fixed decider for one decision point.
export type FixedPoints = Record<string, { answer?: string; probability?: number }>;

export interface EvalSettings {
	noOutgoingAction: boolean;
	evalOwners: boolean;
	channelOutcome: SendOutcome;
	paymentOutcome: SendOutcome;
	deciderPoints: FixedPoints;
	modelScript: RuleScript;
	modelHoldMs: number;
}

// One value of a list. A missing value gives the first item of the list.
function oneOf<T extends string>(name: string, value: string | undefined, list: readonly T[]): T {
	const found = list.find((item) => item === (value ?? list[0]));
	if (found === undefined) throw new SettingError(`The setting ${name} is not one of: ${list.join(", ")}.`);
	return found;
}

// 0 or a positive whole number of milliseconds.
function holdOf(value = "0"): number {
	const ms = Number(value);
	if (!Number.isInteger(ms) || ms < 0)
		throw new SettingError("The setting MODEL_HOLD_MS is not a whole number of milliseconds.");
	return ms;
}

const OUTCOMES = ["confirmed", "not_sent", "unknown"] as const;
const YES_NO = ["no", "yes"] as const;

function fixedPoints(value = "{}"): FixedPoints {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		parsed = undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new SettingError("The setting FIXED_DECIDER_POINTS is not a JSON object.");
	}
	return parsed as FixedPoints;
}

export function evalSettings(env: EvalVars): EvalSettings {
	return {
		noOutgoingAction: oneOf("NO_OUTGOING_ACTION", env.NO_OUTGOING_ACTION, YES_NO) === "yes",
		evalOwners: oneOf("EVAL_OWNERS", env.EVAL_OWNERS, YES_NO) === "yes",
		channelOutcome: oneOf("CHANNEL_OUTCOME", env.CHANNEL_OUTCOME, OUTCOMES),
		paymentOutcome: oneOf("PAYMENT_OUTCOME", env.PAYMENT_OUTCOME, OUTCOMES),
		deciderPoints: fixedPoints(env.FIXED_DECIDER_POINTS),
		modelScript: oneOf("TEST_MODEL_SCRIPT", env.TEST_MODEL_SCRIPT, RULE_SCRIPTS),
		modelHoldMs: holdOf(env.MODEL_HOLD_MS),
	};
}
