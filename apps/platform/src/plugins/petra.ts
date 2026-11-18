// The plug-in list of Petra. One row is one plug-in (requirement C1).
// To replace a plug-in, change its row. Do not change another row.
import { postgresAdapter } from "@tensquads/adapters-postgres";
import { fixedDecider, ruleChecker, ruleModel, testChannel, testIdentity, testPayment } from "@tensquads/adapters-test";
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
}

// The checker double of task 04 always says "stands" (task 06 replaces it).
const stands = () => ({ pass: true, reason: "The checker double of task 04 always says stands." });

export function petraPlugins(database: SqlConnections, bindings: PetraBindings): PluginList {
	return [
		postgresAdapter(database),
		r2ObjectStore(bindings.bucket, `accounts/${bindings.accountId}/`),
		cloudflareQueue(bindings.jobs),
		ruleModel(),
		ruleChecker(stands),
		platformSandbox(bindings.platform),
		fixedDecider(),
		testIdentity(),
		testChannel(),
		testPayment(),
	];
}
