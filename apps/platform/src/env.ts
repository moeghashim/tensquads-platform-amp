// The bindings of the Platform Worker (wrangler.jsonc). The two keys are secrets.
import type { Principal, SqlConnections } from "@tensquads/core";
import type { JobMessage } from "@tensquads/petra";

import { type EvalSettings, type EvalVars, evalSettings, SettingError } from "./eval-settings.js";
import { identityTokens, type ModelVars, modelSettings, type PetraModelSettings } from "./model-settings.js";
import type { PetraObject } from "./petra-object.js";
import type { PlatformDurableObject } from "./platform-object.js";
import type { ShadowDecider } from "./plugins/petra.js";

// The settings of an eval Worker are in EvalVars (task 11).
// The settings of the model of Petra are in ModelVars (task 12).
export interface Env extends EvalVars, ModelVars {
	PETRA: DurableObjectNamespace<PetraObject>;
	PLATFORM: DurableObjectNamespace<PlatformDurableObject>;
	// The R2 bucket of the copies of the journal and, later, of the drafts (section 7.4).
	FILES: R2Bucket;
	// The producer of the queue "jobs". The same Worker is its consumer.
	JOBS: Queue<JobMessage>;
	// One Hyperdrive config for each login user. Locally, wrangler connects each one to its
	// CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_{binding} (scripts/dev.mjs).
	PETRA_HYPERDRIVE: Hyperdrive;
	PLATFORM_HYPERDRIVE: Hyperdrive;
	ADMIN_VIEWS_HYPERDRIVE: Hyperdrive;
	// The key that signs a pass, and the key of the launcher. Both are secrets.
	PASS_KEY?: string;
	LAUNCHER_KEY?: string;
	// The commit of the Worker, for the versions of an attempt (requirement L11).
	WORKER_COMMIT?: string;
	// The times of section 10, in milliseconds.
	ATTEMPT_MAX_MS?: string;
	SILENT_MS?: string;
	LAUNCHER_TAKE_WAIT_MS?: string;
	// The time limit of a tool (section 10). The "check action" job waits this long.
	TOOL_LIMIT_MS?: string;
	// For the tests of the full path: each send of the payment test adapter waits this long. The default is 0.
	PAYMENT_HOLD_MS?: string;
	// The time limit of one decider call (task 09). After it, the answer is "not sure".
	DECIDER_TIMEOUT_MS?: string;
	// The second decider of the shadow mode: "none" or "fixed". The default is "none".
	SHADOW_DECIDER?: string;
	// The value of one credit, in millionths of a US dollar (task 10). The views use it for the difference.
	CREDIT_VALUE_MICROS?: string;
	// A request for a sandbox that no launcher took in this time is stuck (section 7.6).
	LAUNCHER_TAKE_TIME_MS?: string;
	// On staging: the table of tokens of the identity, as JSON (task 12). A secret.
	IDENTITY_TOKENS?: string;
	// The key of each model provider, for example OPENAI_API_KEY (requirement N3). Each one is a secret.
	[key: `${string}_API_KEY`]: string | undefined;
}

export interface Settings {
	passKey: string;
	launcherKey: string;
	workerCommit: string;
	attemptMaxMs: number;
	silentMs: number;
	takeWaitMs: number;
	toolLimitMs: number;
	paymentHoldMs: number;
	deciderTimeoutMs: number;
	shadowDecider: ShadowDecider;
	creditValueMicros: number;
	takeTimeMs: number;
	evals: EvalSettings;
	model: PetraModelSettings;
	identityTokens: Record<string, Principal> | undefined;
}

export { SettingError };

type SettingName =
	| "PASS_KEY"
	| "LAUNCHER_KEY"
	| "WORKER_COMMIT"
	| "ATTEMPT_MAX_MS"
	| "SILENT_MS"
	| "LAUNCHER_TAKE_WAIT_MS"
	| "TOOL_LIMIT_MS"
	| "DECIDER_TIMEOUT_MS"
	| "CREDIT_VALUE_MICROS"
	| "LAUNCHER_TAKE_TIME_MS";

function text(env: Env, name: SettingName): string {
	const value = env[name];
	if (typeof value !== "string" || value === "") throw new SettingError(`The setting ${name} is missing.`);
	return value;
}

function milliseconds(env: Env, name: SettingName, unit = "milliseconds"): number {
	const value = Number(text(env, name));
	if (!Number.isInteger(value) || value <= 0) {
		throw new SettingError(`The setting ${name} is not a positive whole number of ${unit}.`);
	}
	return value;
}

// Each part checks the settings at its start. A missing setting stops the call.
export function readSettings(env: Env): Settings {
	return {
		passKey: text(env, "PASS_KEY"),
		launcherKey: text(env, "LAUNCHER_KEY"),
		workerCommit: text(env, "WORKER_COMMIT"),
		attemptMaxMs: milliseconds(env, "ATTEMPT_MAX_MS"),
		silentMs: milliseconds(env, "SILENT_MS"),
		takeWaitMs: milliseconds(env, "LAUNCHER_TAKE_WAIT_MS"),
		toolLimitMs: milliseconds(env, "TOOL_LIMIT_MS"),
		paymentHoldMs: holdMilliseconds(env.PAYMENT_HOLD_MS),
		deciderTimeoutMs: milliseconds(env, "DECIDER_TIMEOUT_MS"),
		shadowDecider: shadowDeciderOf(env.SHADOW_DECIDER),
		creditValueMicros: milliseconds(env, "CREDIT_VALUE_MICROS", "millionths of a US dollar"),
		takeTimeMs: milliseconds(env, "LAUNCHER_TAKE_TIME_MS"),
		evals: evalSettings(env),
		model: modelSettings(env),
		identityTokens: identityTokens(env.IDENTITY_TOKENS),
	};
}

// One secret of the Worker by its name, for the key of a model provider (requirement N3).
export function secretOf(env: Env, name: string): string | undefined {
	const value = (env as unknown as Record<string, unknown>)[name];
	return typeof value === "string" && value !== "" ? value : undefined;
}

// A setting that can be missing. Its value is 0 or a positive whole number of milliseconds.
function holdMilliseconds(value: string | undefined): number {
	const ms = Number(value ?? "0");
	if (!Number.isInteger(ms) || ms < 0) {
		throw new SettingError("The setting PAYMENT_HOLD_MS is not a whole number of milliseconds.");
	}
	return ms;
}

const SHADOW_DECIDERS: Record<string, ShadowDecider> = { "": "none", none: "none", fixed: "fixed" };

function shadowDeciderOf(value = ""): ShadowDecider {
	const found = Object.hasOwn(SHADOW_DECIDERS, value) ? SHADOW_DECIDERS[value] : undefined;
	if (!found) throw new SettingError('The setting SHADOW_DECIDER is not "none" or "fixed".');
	return found;
}

// Petra gets only her own connection. The Platform object gets its two connections.
export function petraConnections(env: Env): SqlConnections {
	return { petra: env.PETRA_HYPERDRIVE.connectionString };
}

export function platformConnections(env: Env): SqlConnections {
	return {
		platform: env.PLATFORM_HYPERDRIVE.connectionString,
		adminViews: env.ADMIN_VIEWS_HYPERDRIVE.connectionString,
	};
}

// Each error has one form (requirement W4). It never has a stack trace or a key.
export function errorResponse(status: number, code: string, message: string): Response {
	return Response.json({ code, message }, { status });
}
