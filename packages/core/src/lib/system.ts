// The core. It starts a system from a plug-in list, and it removes plug-ins.
// This is the only module in the repository that imports cordis (requirement C3).
import { Context, type Fiber } from "cordis";

import { HOOK_POINTS, type HookPoint, type HookPoints } from "./hooks.js";
import type { PortKey } from "./ports.js";

// What the core gives to a plug-in. A plug-in never sees cordis.
export interface PluginContext {
	// Gives a port to the system. The row of the plug-in must declare the port in "provides".
	provide<T>(key: PortKey<T>, impl: T): void;
	// Gets a port. The row of the plug-in must declare the port in "needs".
	port<T>(key: PortKey<T>): T;
	// Adds a listener to a hook point. The core removes it with the plug-in (requirement C6).
	on<K extends HookPoint>(hook: K, listener: HookPoints[K]): void;
	// Adds a cleanup, for example to close a connection. The core runs it when it removes the plug-in.
	onRemove(cleanup: () => void | Promise<void>): void;
}

// One row of a plug-in list (requirement C1).
export interface Plugin {
	name: string;
	provides: readonly PortKey<unknown>[];
	needs: readonly PortKey<unknown>[];
	apply(ctx: PluginContext): void | Promise<void>;
}

export type PluginList = readonly Plugin[];

type RefusalHook = "tool/before" | "answer/check";
type EventHook = Exclude<HookPoint, RefusalHook>;

export interface System {
	port<T>(key: PortKey<T>): T;
	// Runs the listeners of a hook point.
	emit<K extends EventHook>(hook: K, info: Parameters<HookPoints[K]>[0]): Promise<void>;
	// Runs the listeners of a hook point that can refuse. Returns the first refusal, or undefined.
	ask<K extends RefusalHook>(hook: K, info: Parameters<HookPoints[K]>[0]): Promise<string | undefined>;
	// The names of the plug-ins that are in the system, in the order of the list.
	plugins(): string[];
	// The number of listeners on the hook points of the loop.
	hookCount(): number;
	remove(name: string): Promise<void>;
	// Removes all plug-ins in the reverse order of the list.
	stop(): Promise<void>;
}

export class PluginListError extends Error {
	override name = "PluginListError";
}

function checkList(list: PluginList): void {
	const providers = new Map<string, { plugin: string; row: number }>();
	const names = new Set<string>();
	list.forEach((plugin, row) => {
		if (names.has(plugin.name)) {
			throw new PluginListError(`The plug-in list has the plug-in "${plugin.name}" two times.`);
		}
		names.add(plugin.name);
		for (const key of plugin.provides) {
			const other = providers.get(key.name);
			if (other) {
				throw new PluginListError(
					`The plug-ins "${other.plugin}" and "${plugin.name}" both provide the port "${key.name}". Remove one of them.`,
				);
			}
			providers.set(key.name, { plugin: plugin.name, row });
		}
	});
	list.forEach((plugin, row) => {
		for (const key of plugin.needs) {
			const provider = providers.get(key.name);
			if (!provider) {
				throw new PluginListError(
					`The plug-in "${plugin.name}" needs the port "${key.name}". No plug-in in the list provides it.`,
				);
			}
			if (provider.row > row) {
				throw new PluginListError(
					`The plug-in "${plugin.name}" needs the port "${key.name}", but its provider "${provider.plugin}" comes later in the list. Move "${provider.plugin}" up.`,
				);
			}
		}
	});
}

function pluginContext(ctx: Context, plugin: Plugin, registry: Map<string, unknown>): PluginContext {
	return {
		provide(key, impl) {
			if (!plugin.provides.some((declared) => declared.name === key.name)) {
				throw new PluginListError(
					`The plug-in "${plugin.name}" provides the port "${key.name}", but its row does not declare it.`,
				);
			}
			registry.set(key.name, impl);
			ctx.effect(() => () => {
				registry.delete(key.name);
			});
		},
		port(key) {
			if (!plugin.needs.some((declared) => declared.name === key.name)) {
				throw new PluginListError(
					`The plug-in "${plugin.name}" uses the port "${key.name}", but its row does not declare it in "needs".`,
				);
			}
			return portOf(registry, key);
		},
		on(hook, listener) {
			ctx.on(hook, listener as never);
		},
		onRemove(cleanup) {
			ctx.effect(() => cleanup);
		},
	};
}

function portOf<T>(registry: Map<string, unknown>, key: PortKey<T>): T {
	if (!registry.has(key.name)) {
		throw new PluginListError(`No plug-in in the system provides the port "${key.name}".`);
	}
	return registry.get(key.name) as T;
}

// Starts a system from a plug-in list. It checks the list before it applies a plug-in (requirement C5).
export async function startSystem(list: PluginList): Promise<System> {
	checkList(list);
	const root = new Context();
	const registry = new Map<string, unknown>();
	const fibers = new Map<string, Fiber>();
	for (const plugin of list) {
		const fiber = await root.use((ctx: Context) => plugin.apply(pluginContext(ctx, plugin, registry)));
		fibers.set(plugin.name, fiber);
	}

	async function remove(name: string): Promise<void> {
		const fiber = fibers.get(name);
		if (!fiber) {
			throw new PluginListError(`The system has no plug-in "${name}".`);
		}
		fibers.delete(name);
		await fiber.dispose();
	}

	return {
		port: (key) => portOf(registry, key),
		emit: async (hook, info) => {
			await root.parallel(hook, info as never);
		},
		ask: async (hook, info) => (await root.serial(hook, info as never)) ?? undefined,
		plugins: () => [...fibers.keys()],
		hookCount: () => HOOK_POINTS.reduce((sum, hook) => sum + (root.events._hooks[hook]?.length ?? 0), 0),
		remove,
		stop: async () => {
			for (const name of [...fibers.keys()].reverse()) {
				await remove(name);
			}
		},
	};
}
