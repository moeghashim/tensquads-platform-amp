// The plug-in list of the Platform object. One row is one plug-in (requirement C1).
// To replace a plug-in, change its row. Do not change another row.
// Task 03 adds the database adapter and the platform writer.
import { testIdentity } from "@tensquads/adapters-test";
import type { PluginList } from "@tensquads/core";

export const platformPlugins: PluginList = [testIdentity()];
