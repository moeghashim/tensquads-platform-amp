// The tests that run inside the Workers runtime: the Worker and the two Durable Objects.
// They connect to the Postgres of DATABASE_URL with the three login users (README.md, Setup).
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { loginConnections } from "./test/login-urls.js";

const connections = loginConnections();

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					PETRA_DATABASE_URL: connections.petra,
					PLATFORM_DATABASE_URL: connections.platform,
					ADMIN_VIEWS_DATABASE_URL: connections.adminViews,
				},
			},
		}),
	],
	test: {
		include: ["test-workers/**/*.test.ts"],
		globalSetup: ["./test-workers/global-setup.ts"],
	},
});
