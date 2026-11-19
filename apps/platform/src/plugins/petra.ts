// The plug-in list of Petra. One row is one plug-in (requirement C1).
// To replace a plug-in, change its row. Do not change another row.
import { postgresAdapter } from "@tensquads/adapters-postgres";
import {
	fixedDecider,
	noShadowDecider,
	ruleChecker,
	ruleModel,
	testChannel,
	testIdentity,
	testPayment,
} from "@tensquads/adapters-test";
import type { PluginList, SqlConnections } from "@tensquads/core";

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
}

export type ShadowDecider = "none" | "fixed";

const waitFor = (ms: number) => () => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function petraPlugins(database: SqlConnections, bindings: PetraBindings): PluginList {
	return [
		postgresAdapter(database),
		r2ObjectStore(bindings.bucket, `accounts/${bindings.accountId}/`),
		cloudflareQueue(bindings.jobs),
		ruleModel(),
		// The checker model has its own row, apart from the row of the model of the bot (requirement K2).
		ruleChecker(),
		platformSandbox(bindings.platform),
		fixedDecider(),
		// The shadow mode has its own row (requirement Q5). Its answers are recorded and never used.
		bindings.shadowDecider === "fixed" ? fixedDecider({ shadow: true }) : noShadowDecider(),
		testIdentity(),
		// The test adapters write each send to the log of the Worker. The tests of the full path count these lines.
		testChannel({ log: console.log }),
		testPayment({ log: console.log, ...(bindings.paymentHoldMs ? { hold: waitFor(bindings.paymentHoldMs) } : {}) }),
	];
}
