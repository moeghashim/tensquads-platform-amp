// The plug-in list of the runner. One row is one plug-in (requirement C1).
// To replace a plug-in, change its row. Do not change another row.
// The runner has no model row: each model call goes through the link to the gateway (requirement L10).
// The loop has no hook listener in the runner. The listeners of this build run on Cloudflare.
import { createHash } from "node:crypto";
import { testBotPlugin } from "@tensquads/bot-test";
import type { Plugin, PluginList } from "@tensquads/core";
import { type HttpLinkOptions, linkPlugin } from "@tensquads/link";
import { RefusedError } from "@tensquads/loop";

// The settings of the link that the runner knows at its start.
export type LinkSettings = Omit<HttpLinkOptions, "pluginListHash" | "refused">;

// The hash of the plug-in list is the SHA-256 of the names of its rows, in sequence (requirement L11).
export function pluginListHash(names: readonly string[]): string {
	return createHash("sha256").update(names.join("\n")).digest("hex");
}

function rows(settings: LinkSettings, hash: string): Plugin[] {
	return [
		linkPlugin({ ...settings, pluginListHash: hash, refused: (reason, call) => new RefusedError(reason, call) }),
		testBotPlugin(),
	];
}

// The names of the rows do not change with the settings. Thus the hash is the same for each runner of one commit.
export function runnerPlugins(settings: LinkSettings): PluginList {
	return rows(settings, pluginListHash(rows(settings, "").map((row) => row.name)));
}
