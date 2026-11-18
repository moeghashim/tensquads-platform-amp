// The bindings of the Platform Worker (wrangler.jsonc). The database URLs are secrets.
import type { SqlConnections } from "@tensquads/core";

import type { PetraObject } from "./petra-object.js";
import type { PlatformDurableObject } from "./platform-object.js";

export interface Env {
	PETRA: DurableObjectNamespace<PetraObject>;
	PLATFORM: DurableObjectNamespace<PlatformDurableObject>;
	PETRA_DATABASE_URL?: string;
	PLATFORM_DATABASE_URL?: string;
	ADMIN_VIEWS_DATABASE_URL?: string;
}

// Petra gets only her own connection. The Platform object gets its two connections.
export function petraConnections(env: Env): SqlConnections {
	return { petra: env.PETRA_DATABASE_URL };
}

export function platformConnections(env: Env): SqlConnections {
	return { platform: env.PLATFORM_DATABASE_URL, adminViews: env.ADMIN_VIEWS_DATABASE_URL };
}

// Each error has one form (requirement W4). It never has a stack trace or a key.
export function errorResponse(status: number, code: string, message: string): Response {
	return Response.json({ code, message }, { status });
}
