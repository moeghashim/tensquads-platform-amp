// The plug-in list of Petra. One row is one plug-in (requirement C1).
// To replace a plug-in, change its row. Do not change another row.
import { type ModelSettings, piModel } from "@tensquads/adapters-model";
import { postgresAdapter } from "@tensquads/adapters-postgres";
import {
	fixedDecider,
	modelDecider,
	noShadowDecider,
	petraTestModel,
	ruleChecker,
	ruleModel,
	testChannel,
	testIdentity,
	testPayment,
} from "@tensquads/adapters-test";
import { type Model, type Plugin, type PluginList, ports, type SqlConnections } from "@tensquads/core";
import { limitedModel } from "@tensquads/petra";

import type { EvalSettings } from "../eval-settings.js";
import {
	type BucketBinding,
	cloudflareQueue,
	type PlatformBinding,
	platformSandbox,
	type QueueBinding,
	r2ObjectStore,
} from "./cloudflare.js";

export interface PetraBindings {
	accountId: string;
	bucket: BucketBinding;
	jobs: QueueBinding;
	platform: PlatformBinding;
	// Each payment of the test adapter waits this long (the setting PAYMENT_HOLD_MS). The default is 0.
	paymentHoldMs?: number;
	// The second decider of the shadow mode (the setting SHADOW_DECIDER). The default is "none".
	shadowDecider?: ShadowDecider;
	// The settings of an eval Worker (task 11). With none, each row keeps its default.
	evals?: EvalSettings;
	// Gets the line of each send of the test adapters. The default is the log of the Worker.
	log?: (line: string) => void;
	// Only for an account with the "real" profile (decision D30): the model, the base URL and the secrets of the Worker.
	// Without them, Petra uses the model of the list.
	realModel?: ModelSettings;
	// The time limit of one model call of Petra (the setting MODEL_TIMEOUT_MS). The default is its first value.
	modelTimeoutMs?: number;
}

// The first value of the setting MODEL_TIMEOUT_MS (section 10).
const MODEL_TIMEOUT_MS = 60_000;

// The row of the model of Petra, with the time limit and the second try on the port (requirement N6). The loop,
// the decider and the night job get the same port, so each call gets them one time.
function limitedRow(row: Plugin, options: Parameters<typeof limitedModel>[1]): Plugin {
	return {
		...row,
		apply: (ctx) =>
			row.apply({
				...ctx,
				provide: (key, impl) =>
					key.name === ports.petraModel.name
						? ctx.provide(ports.petraModel, limitedModel(impl as Model, options))
						: ctx.provide(key, impl),
			}),
	};
}

export type ShadowDecider = "none" | "fixed";

const waitFor = (ms: number) => () => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function petraPlugins(database: SqlConnections, bindings: PetraBindings): PluginList {
	const evals = bindings.evals;
	const log = bindings.log ?? console.log;
	// In the mode with no outgoing action, the channel and the payment only record (requirement E2).
	const record = evals?.noOutgoingAction ?? false;
	return [
		postgresAdapter(database),
		r2ObjectStore(bindings.bucket, `accounts/${bindings.accountId}/`),
		cloudflareQueue(bindings.jobs),
		ruleModel({
			script: evals?.modelScript ?? "base",
			...(evals?.modelHoldMs ? { hold: waitFor(evals.modelHoldMs) } : {}),
		}),
		// The model of Petra (decision D30). The row of a "real" account names the provider. A swap of the provider
		// changes this row, the setting PETRA_MODEL, the secret of the key and the price (requirement N7).
		limitedRow(bindings.realModel ? piModel({ provider: "openai", ...bindings.realModel }) : petraTestModel(), {
			timeoutMs: bindings.modelTimeoutMs ?? MODEL_TIMEOUT_MS,
			log,
		}),
		// The checker model has its own row, apart from the row of the model of the bot (requirement K2).
		ruleChecker(),
		platformSandbox(bindings.platform),
		// The decider of a "real" account asks the model of Petra (task 12).
		bindings.realModel
			? modelDecider({ port: ports.petraModel })
			: fixedDecider({ points: evals?.deciderPoints ?? {} }),
		// The shadow mode has its own row (requirement Q5). Its answers are recorded and never used.
		bindings.shadowDecider === "fixed" ? fixedDecider({ shadow: true }) : noShadowDecider(),
		testIdentity(),
		// The test adapters write each send to the log of the Worker. The tests of the full path count these lines.
		testChannel({ log, record, answer: evals?.channelOutcome ?? "confirmed" }),
		testPayment({
			log,
			record,
			answer: evals?.paymentOutcome ?? "confirmed",
			...(bindings.paymentHoldMs ? { hold: waitFor(bindings.paymentHoldMs) } : {}),
		}),
	];
}
