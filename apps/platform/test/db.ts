// The database of the Node tests of the platform. It needs the migrations and the login users (README.md).
import { randomUUID } from "node:crypto";

import { postgresDatabase } from "@tensquads/adapters-postgres";
import type { Database } from "@tensquads/core";

import { loginConnections } from "./login-urls.js";

export function testDatabase(): Database {
	return postgresDatabase(loginConnections());
}

// A new id for each test run, so tests on one database do not see the rows of another run.
export function uniqueId(prefix: string): string {
	return `${prefix}-${randomUUID().slice(0, 8)}`;
}
