// Requirement V4. This test runs in its own CI job against a Neon branch, not on each pull request.
import { databaseContract } from "@tensquads/core/contract-tests";

import { neonDatabase } from "../src/index.js";

const petra = process.env.NEON_PETRA_URL;
const platform = process.env.NEON_PLATFORM_URL;
const adminViews = process.env.NEON_ADMIN_VIEWS_URL;
if (!petra || !platform || !adminViews) {
	throw new Error(
		"V4: set NEON_PETRA_URL, NEON_PLATFORM_URL and NEON_ADMIN_VIEWS_URL to the login users of a Neon branch.",
	);
}

databaseContract("V4: database-neon", async () => neonDatabase({ petra, platform, adminViews }));
