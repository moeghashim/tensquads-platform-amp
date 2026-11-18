// The plug-in list of the runner. One row is one plug-in (requirement C1).
// To replace a plug-in, change its row. Do not change another row.
// Task 04 replaces the model row with the link plug-in, and adds the loop and the test bot.
import { echoModel } from "@tensquads/adapters-test";
import type { PluginList } from "@tensquads/core";

export const runnerPlugins: PluginList = [echoModel()];
