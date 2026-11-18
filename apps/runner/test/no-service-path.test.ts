import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ports, startSystem } from "@tensquads/core";

import { runnerPlugins } from "../src/plugins.js";

// Requirement G1: the runner cannot call a service directly. An action goes only through the gate on Cloudflare.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SERVICE_PORTS = [ports.channel.name, ports.payment.name];
// The packages that hold the gate, the services and their adapters. They run on Cloudflare only.
const CLOUDFLARE_ONLY = ["@tensquads/gate", "@tensquads/gateway", "@tensquads/petra", "@tensquads/adapters-test"];
// A use of a service port in source text: the key in `ports`, or the name of the key.
const SERVICE_USE =
	/\bports\s*(\.\s*(channel|payment)\b|\[\s*["'](channel|payment)["']\s*\])|portKey<(Channel|Payment)>/;

interface Workspace {
	dir: string;
	dependencies: string[];
}

// The workspace packages of the repository, by name.
function workspaces(): Map<string, Workspace> {
	const found = new Map<string, Workspace>();
	for (const group of ["apps", "packages"]) {
		for (const entry of readdirSync(join(ROOT, group), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dir = join(ROOT, group, entry.name);
			let manifest: { name?: string; dependencies?: Record<string, string> };
			try {
				manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			} catch {
				continue;
			}
			if (manifest.name !== undefined) {
				found.set(manifest.name, { dir, dependencies: Object.keys(manifest.dependencies ?? {}) });
			}
		}
	}
	return found;
}

// The runner and each workspace package that it needs at run time, also through another package.
function runtimeClosure(): Map<string, Workspace> {
	const all = workspaces();
	const closure = new Map<string, Workspace>();
	const queue = ["@tensquads/runner"];
	for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
		const workspace = all.get(name);
		if (workspace === undefined || closure.has(name)) continue;
		closure.set(name, workspace);
		queue.push(...workspace.dependencies);
	}
	return closure;
}

function sourceFiles(dir: string): string[] {
	return readdirSync(join(dir, "src"), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => join(entry.parentPath, entry.name));
}

test("G1: no row of the plug-in list of the runner provides or needs the channel or the payment port", async () => {
	const list = runnerPlugins({ workerUrl: "http://worker.test", pass: "p", runnerId: "r-1", runnerCommit: "c" });
	for (const row of list) {
		const keys = [...row.provides, ...row.needs].map((key) => key.name);
		for (const name of SERVICE_PORTS) {
			assert.ok(!keys.includes(name), `The row "${row.name}" has the port "${name}".`);
		}
	}
	const system = await startSystem(list);
	try {
		assert.throws(() => system.port(ports.channel));
		assert.throws(() => system.port(ports.payment));
	} finally {
		await system.stop();
	}
});

test("G1: no package that the runner needs at run time uses the channel or the payment port", () => {
	const closure = runtimeClosure();
	assert.ok(closure.has("@tensquads/loop") && closure.has("@tensquads/link") && closure.has("@tensquads/core"));
	for (const name of CLOUDFLARE_ONLY) {
		assert.ok(!closure.has(name), `The runner needs the package ${name}.`);
	}
	for (const [name, workspace] of closure) {
		// The core declares the ports. Each other package that uses a service port is a path to a service.
		if (name === "@tensquads/core") continue;
		for (const file of sourceFiles(workspace.dir)) {
			const source = readFileSync(file, "utf8");
			assert.doesNotMatch(source, SERVICE_USE, `The file ${file} uses a service port.`);
			for (const other of CLOUDFLARE_ONLY) {
				assert.ok(!source.includes(`"${other}`), `The file ${file} imports ${other}.`);
			}
		}
	}
});

test("G1: the check finds a use of a service port", () => {
	// A plausible change that adds a path to a service. The check must see it.
	assert.match("const pay = system.port(ports.payment);", SERVICE_USE);
	assert.match('ctx.provide(ports["channel"], adapter);', SERVICE_USE);
	assert.doesNotMatch("system.port(ports.model)", SERVICE_USE);
});
