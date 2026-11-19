// The plug-in list of the Platform object. One row is one plug-in (requirement C1).
// To replace a plug-in, change its row. Do not change another row.
// The Platform Worker also starts this list, with no database connection, to get the identity port.
import { postgresAdapter } from "@tensquads/adapters-postgres";
import { testIdentity } from "@tensquads/adapters-test";
import type { PluginList, Principal, SqlConnections } from "@tensquads/core";

// With evalOwners (the setting EVAL_OWNERS), the identity knows the owner of each eval account (task 11).
// With tokens (the secret IDENTITY_TOKENS on staging), the identity knows only those tokens (task 12).
export function platformPlugins(
	database: SqlConnections,
	options: { evalOwners?: boolean; tokens?: Record<string, Principal> } = {},
): PluginList {
	const tokens = options.tokens ? { tokens: options.tokens } : {};
	return [postgresAdapter(database), testIdentity({ evalOwners: options.evalOwners ?? false, ...tokens })];
}
