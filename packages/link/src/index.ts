// The link: the client of the gateway for a runner (ARCHITECTURE section 3.2).
import type { Plugin, PortKey } from "@tensquads/core";

import { type HttpLink, type HttpLinkOptions, httpLink } from "./http-link.js";

export { type HttpLink, type HttpLinkOptions, httpLink, type ModelLimit, type RefusalReason } from "./http-link.js";

// The key of the link in the plug-in list of the runner.
export const linkPort: PortKey<HttpLink> = { name: "link" };

// One row of the plug-in list of the runner. It gives the link to the runner.
export function linkPlugin(options: HttpLinkOptions): Plugin {
	return {
		name: "link",
		provides: [linkPort],
		needs: [],
		apply(ctx) {
			ctx.provide(linkPort, httpLink(options));
		},
	};
}
