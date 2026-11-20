// The tests that run inside the Workers runtime: the Worker and the two Durable Objects.
// They connect to the Postgres of DATABASE_URL with the three login users (README.md, Setup).
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { loginConnections } from "./test/login-urls.js";

const connections = loginConnections();
// Wrangler reads wrangler.jsonc and connects each Hyperdrive binding to the test database, with its login user.
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_PETRA_HYPERDRIVE = connections.petra;
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_PLATFORM_HYPERDRIVE = connections.platform;
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_ADMIN_VIEWS_HYPERDRIVE = connections.adminViews;

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
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
