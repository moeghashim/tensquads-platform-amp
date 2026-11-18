// The test adapter of the sandbox port. It records each request. The launcher takes the list later.
import { type Plugin, ports, type SandboxRequest } from "@tensquads/core";

export function localSandbox(options: { started?: SandboxRequest[] } = {}): Plugin {
	const started = options.started ?? [];
	return {
		name: "sandbox-local",
		provides: [ports.sandbox],
		needs: [],
		apply: (ctx) => {
			ctx.provide(ports.sandbox, {
				start: async (request) => {
					const known = started.some(
						(item) => item.taskId === request.taskId && item.attemptNo === request.attemptNo,
					);
					// A second start of the same attempt does not record the request again.
					if (!known) {
						started.push({ ...request });
					}
					return { sandboxId: `sandbox-${request.taskId}-${request.attemptNo}` };
				},
			});
		},
	};
}
