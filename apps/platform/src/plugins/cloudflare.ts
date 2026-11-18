// The plug-ins that use a binding of the Worker: the object store on R2, the queue on Cloudflare Queues,
// and the sandbox port that gives each request to the list of the Platform object (section 3.6).
// Each binding is a small structural type, so the Node tests can give a fake binding.
import type { Plugin, QueueName, SandboxRequest } from "@tensquads/core";
import { ports } from "@tensquads/core";

// The part of an R2 bucket that the object store uses.
export interface BucketBinding {
	put(key: string, body: string): Promise<unknown>;
	get(key: string): Promise<{ text(): Promise<string> } | null>;
	delete(key: string): Promise<void>;
}

// The part of a Cloudflare queue producer that the queue port uses.
export interface QueueBinding {
	send(body: unknown, options?: { delaySeconds?: number }): Promise<unknown>;
}

// The part of the stub of the Platform object that the sandbox port uses.
export interface PlatformBinding {
	fetch(url: string, init?: RequestInit): Promise<Response>;
}

// Each key starts with the prefix of the account (section 7.4). Thus a read never sees an object of another account.
export function r2ObjectStore(bucket: BucketBinding, prefix: string): Plugin {
	return {
		name: "object-store-r2",
		provides: [ports.objectStore],
		needs: [],
		apply: (ctx) => {
			ctx.provide(ports.objectStore, {
				put: async (key, body) => {
					await bucket.put(`${prefix}${key}`, body);
				},
				get: async (key) => {
					const object = await bucket.get(`${prefix}${key}`);
					return object ? object.text() : undefined;
				},
				delete: (key) => bucket.delete(`${prefix}${key}`),
			});
		},
	};
}

// The Worker has the queue "jobs" only. The queue "events" comes in a later task.
export function cloudflareQueue(jobs: QueueBinding): Plugin {
	return {
		name: "queue-cloudflare",
		provides: [ports.queue],
		needs: [],
		apply: (ctx) => {
			ctx.provide(ports.queue, {
				send: async (queue: QueueName, body, options) => {
					if (queue !== "jobs") throw new Error(`The Worker has no binding for the queue "${queue}".`);
					await jobs.send(body, options);
				},
			});
		},
	};
}

// The test adapter of the sandbox port in the Worker. The Platform object keeps one request for each task and attempt.
export function platformSandbox(platform: PlatformBinding): Plugin {
	return {
		name: "sandbox-platform-list",
		provides: [ports.sandbox],
		needs: [],
		apply: (ctx) => {
			ctx.provide(ports.sandbox, {
				start: async (request: SandboxRequest) => {
					const response = await platform.fetch("https://platform/sandbox/put", {
						method: "POST",
						body: JSON.stringify(request),
					});
					if (!response.ok) throw new Error(`The Platform object did not take the request: ${response.status}`);
					return { sandboxId: `${request.taskId}/${request.attemptNo}` };
				},
			});
		},
	};
}
