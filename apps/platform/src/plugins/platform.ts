// The plug-in list of the Platform object. One row is one plug-in (requirement C1).
// To replace a plug-in, change its row. Do not change another row.
// The Platform Worker also starts this list, with no database connection, to get the identity port.
import { postgresAdapter } from "@tensquads/adapters-postgres";
import { testIdentity } from "@tensquads/adapters-test";
import type { PluginList, SqlConnections } from "@tensquads/core";

export function platformPlugins(database: SqlConnections): PluginList {
	return [postgresAdapter(database), testIdentity()];
}
