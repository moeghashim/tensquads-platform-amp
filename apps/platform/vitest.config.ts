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
					// The two keys are secrets. The tests use fixed values. A short take wait keeps the tests fast.
					PASS_KEY: "test-pass-key",
					LAUNCHER_KEY: "test-launcher-key",
					LAUNCHER_TAKE_WAIT_MS: "200",
				},
			},
		}),
	],
	test: {
		include: ["test-workers/**/*.test.ts"],
		globalSetup: ["./test-workers/global-setup.ts"],
		// The test files use the same accounts and the same list of sandboxes. They run one after the other.
		fileParallelism: false,
	},
});
