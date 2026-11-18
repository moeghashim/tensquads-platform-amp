// The plug-in list of Petra. One row is one plug-in (requirement C1).
// To replace a plug-in, change its row. Do not change another row.
// The object store and the queue rows come with their real adapters.
import { postgresAdapter } from "@tensquads/adapters-postgres";
import {
	echoModel,
	fixedDecider,
	localSandbox,
	ruleChecker,
	testChannel,
	testIdentity,
	testPayment,
} from "@tensquads/adapters-test";
import type { PluginList, SqlConnections } from "@tensquads/core";

export function petraPlugins(database: SqlConnections): PluginList {
	return [
		postgresAdapter(database),
		echoModel(),
		ruleChecker(),
		localSandbox(),
		fixedDecider(),
		testIdentity(),
		testChannel(),
		testPayment(),
	];
}
