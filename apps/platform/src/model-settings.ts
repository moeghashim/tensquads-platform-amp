// The settings of the model of Petra and of the identity on staging (task 12). This file has no type of Cloudflare,
// so the Node tests can import it. A missing or wrong setting stops the start. The message names the setting and
// never its value (section 10).
import type { Principal } from "@tensquads/core";

import { SettingError } from "./eval-settings.js";

export interface ModelVars {
	// The time limit of one model call of Petra (requirement N6).
	MODEL_TIMEOUT_MS?: string;
	// The model of Petra for an account with the "real" profile, for example gpt-6.2-sol. The plug-in row names the
	// provider, and the secret <PROVIDER>_API_KEY has the key (requirement N7).
	PETRA_MODEL?: string;
	// An other address of the provider, for example for GLM. Optional.
	PETRA_MODEL_BASE_URL?: string;
}

export interface PetraModelSettings {
	timeoutMs: number;
	petraModel: string;
	baseUrl?: string;
}

export function modelSettings(vars: ModelVars): PetraModelSettings {
	if (!vars.MODEL_TIMEOUT_MS) throw new SettingError("The setting MODEL_TIMEOUT_MS is missing.");
	const timeoutMs = Number(vars.MODEL_TIMEOUT_MS);
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new SettingError("The setting MODEL_TIMEOUT_MS is not a positive whole number of milliseconds.");
	}
	return {
		timeoutMs,
		petraModel: vars.PETRA_MODEL ?? "",
		...(vars.PETRA_MODEL_BASE_URL ? { baseUrl: vars.PETRA_MODEL_BASE_URL } : {}),
	};
}

function isPrincipal(value: unknown): value is Principal {
	if (typeof value !== "object" || value === null) return false;
	const item = value as Record<string, unknown>;
	if (item.kind === "owner") return typeof item.ownerId === "string" && typeof item.accountId === "string";
	return item.kind === "super_admin" && typeof item.adminId === "string";
}

// The table of tokens of the identity on staging (the secret IDENTITY_TOKENS): a JSON object of token to principal.
// With no secret, the identity keeps its test tokens.
export function identityTokens(value: string | undefined): Record<string, Principal> | undefined {
	if (value === undefined || value === "") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		parsed = undefined;
	}
	const valid =
		typeof parsed === "object" &&
		parsed !== null &&
		!Array.isArray(parsed) &&
		Object.values(parsed).every(isPrincipal);
	if (!valid) throw new SettingError("The secret IDENTITY_TOKENS is not a JSON object of tokens and principals.");
	return parsed as Record<string, Principal>;
}
