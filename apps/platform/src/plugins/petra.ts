// The plug-in list of Petra. One row is one plug-in (requirement C1).
// To replace a plug-in, change its row. Do not change another row.
// Task 03 adds the database, object store and queue adapters, and the petra plug-in.
import {
	echoModel,
	fixedDecider,
	localSandbox,
	ruleChecker,
	testChannel,
	testIdentity,
	testPayment,
} from "@tensquads/adapters-test";
import type { PluginList } from "@tensquads/core";

export const petraPlugins: PluginList = [
	echoModel(),
	ruleChecker(),
	localSandbox(),
	fixedDecider(),
	testIdentity(),
	testChannel(),
	testPayment(),
];
