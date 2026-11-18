import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { root, tempDir } from "./helpers.mjs";

const SCRIPT = join(root, "scripts/check-boundaries.mjs");

// Make a fixture tree with the given files, then run the script on it.
function check(t, files) {
	const directory = tempDir(t, "boundaries-");
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, name)), { recursive: true });
		writeFileSync(join(directory, name), content);
	}
	return spawnSync(process.execPath, [SCRIPT, directory], { encoding: "utf8" });
}

function assertPasses(result) {
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /C2 passed/);
	assert.match(result.stdout, /C3 passed/);
	assert.match(result.stdout, /C4 passed/);
}

function assertFails(result, rule, file) {
	assert.equal(result.status, 1, result.stdout);
	assert.ok(result.stderr.includes(`${rule}: ${file}: `), result.stderr);
}

// The packages of each fixture. "gate" and "trail" are plug-ins.
const packages = {
	"packages/core/src/index.ts": "export {};\n",
	"packages/contracts/src/index.ts": "export {};\n",
	"packages/bots/src/index.ts": "export {};\n",
	"packages/trail/src/index.ts": "export {};\n",
};

test("C2: a plug-in that imports another plug-in fails", (t) => {
	const result = check(t, {
		...packages,
		"packages/gate/src/index.ts": 'import { trail } from "@tensquads/trail";\n',
	});
	assertFails(result, "C2", "packages/gate/src/index.ts");
});

test("C2: a plug-in that imports a subpath of another plug-in fails", (t) => {
	const result = check(t, { ...packages, "packages/gate/src/a.ts": 'import x from "@tensquads/trail/src/x.js";\n' });
	assertFails(result, "C2", "packages/gate/src/a.ts");
});

test("C2: a plug-in that re-exports another plug-in fails", (t) => {
	const result = check(t, { ...packages, "packages/gate/src/a.ts": 'export { trail } from "@tensquads/trail";\n' });
	assertFails(result, "C2", "packages/gate/src/a.ts");
});

test("C2: a type-only import of another plug-in fails", (t) => {
	const result = check(t, {
		...packages,
		"packages/gate/src/a.ts": 'import type { Trail } from "@tensquads/trail";\n',
	});
	assertFails(result, "C2", "packages/gate/src/a.ts");
});

test("C2: a dynamic import or a require of another plug-in fails", (t) => {
	const dynamic = check(t, { ...packages, "packages/gate/src/a.ts": 'const m = await import("@tensquads/trail");\n' });
	assertFails(dynamic, "C2", "packages/gate/src/a.ts");
	const required = check(t, { ...packages, "packages/gate/src/a.js": 'const m = require("@tensquads/trail");\n' });
	assertFails(required, "C2", "packages/gate/src/a.js");
});

test("C2: a side-effect import of another plug-in fails", (t) => {
	const result = check(t, { ...packages, "packages/gate/src/a.ts": 'import "@tensquads/trail";\n' });
	assertFails(result, "C2", "packages/gate/src/a.ts");
});

test("C2: a relative import that leaves the package fails", (t) => {
	const result = check(t, { ...packages, "packages/gate/src/a.ts": 'import x from "../../trail/src/index.js";\n' });
	assertFails(result, "C2", "packages/gate/src/a.ts");
});

test("C2: a plug-in may import the shared packages and its own files", (t) => {
	const result = check(t, {
		...packages,
		"packages/gate/src/a.ts": [
			'import { core } from "@tensquads/core";',
			'import type { Brief } from "@tensquads/contracts";',
			'import { bots } from "@tensquads/bots";',
			'import { b } from "./b.js";',
			'import { c } from "../test/c.js";',
			'export { gate } from "@tensquads/gate";',
			"",
		].join("\n"),
		"packages/gate/src/b.ts": "export const b = 1;\n",
	});
	assertPasses(result);
});

test("C2: an app may import a plug-in", (t) => {
	const result = check(t, {
		...packages,
		"packages/gate/src/index.ts": "export {};\n",
		"apps/platform/src/plugins/petra.ts": 'import { gate } from "@tensquads/gate";\nimport "@tensquads/trail";\n',
	});
	assertPasses(result);
});

test("C3: a package outside the core that imports cordis fails", (t) => {
	const result = check(t, { ...packages, "packages/gate/src/a.ts": 'import { Context } from "cordis";\n' });
	assertFails(result, "C3", "packages/gate/src/a.ts");
});

test("C3: an app that imports a cordis subpath fails", (t) => {
	const result = check(t, { ...packages, "apps/runner/src/main.ts": 'import type { Fiber } from "cordis/fiber";\n' });
	assertFails(result, "C3", "apps/runner/src/main.ts");
});

test("C3: the shared package contracts that imports cordis fails", (t) => {
	const result = check(t, { ...packages, "packages/contracts/src/a.ts": 'export * from "cordis";\n' });
	assertFails(result, "C3", "packages/contracts/src/a.ts");
});

test("C3: the core may import cordis, and cordis-tools is not cordis", (t) => {
	const result = check(t, {
		...packages,
		"packages/core/src/system.ts": 'import { Context } from "cordis";\nimport type { Fiber } from "cordis/fiber";\n',
		"packages/gate/src/a.ts": 'import { tool } from "cordis-tools";\n',
	});
	assertPasses(result);
});

test("C4: a business package that imports pg fails", (t) => {
	const result = check(t, { ...packages, "packages/gate/src/a.ts": 'import { Pool } from "pg";\n' });
	assertFails(result, "C4", "packages/gate/src/a.ts");
});

test("C4: a subpath of a forbidden module fails", (t) => {
	const result = check(t, { ...packages, "packages/memory/src/a.ts": 'import { Client } from "pg/lib/client";\n' });
	assertFails(result, "C4", "packages/memory/src/a.ts");
});

test("C4: a package in a forbidden scope fails", (t) => {
	const result = check(t, {
		...packages,
		"packages/costs/src/a.ts": 'import type { R2Bucket } from "@cloudflare/workers-types";\n',
	});
	assertFails(result, "C4", "packages/costs/src/a.ts");
});

test("C4: a model SDK in a shared business package fails", (t) => {
	const result = check(t, { ...packages, "packages/bots/src/a.ts": 'export { default } from "openai";\n' });
	assertFails(result, "C4", "packages/bots/src/a.ts");
});

test("C4: pgx is not pg, and adapters and apps may import pg", (t) => {
	const result = check(t, {
		...packages,
		"packages/gate/src/a.ts": 'import x from "pgx";\nimport y from "openai-like";\n',
		"packages/adapters-postgres/src/a.ts": 'import { Pool } from "pg";\n',
		"packages/adapters-cloudflare/src/a.ts": 'import type { R2Bucket } from "@cloudflare/workers-types";\n',
		"apps/web/src/a.ts": 'import Stripe from "stripe";\n',
	});
	assertPasses(result);
});

test("C2 C3 C4: the script skips node_modules and dist", (t) => {
	const result = check(t, {
		...packages,
		"packages/gate/node_modules/x/index.js": 'import "cordis";\nimport "pg";\n',
		"packages/gate/dist/index.js": 'import "@tensquads/trail";\n',
	});
	assertPasses(result);
});

test("C2 C3 C4: the real repository passes", () => {
	const result = spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
	assertPasses(result);
});

test("P2: a package other than petra that writes to the database fails", (t) => {
	const result = check(t, {
		...packages,
		"packages/gate/src/a.ts": 'await tx.query("INSERT INTO actions (task_id) VALUES ($1)", [id]);\n',
	});
	assertFails(result, "P2", "packages/gate/src/a.ts");
});

test("P2: an update, a delete or a truncate in an app fails", (t) => {
	for (const sql of ["UPDATE events SET status = 'done'", "DELETE FROM ledger", "TRUNCATE trail"]) {
		const result = check(t, { ...packages, "apps/platform/src/a.ts": `const q = "${sql}";\n` });
		assertFails(result, "P2", "apps/platform/src/a.ts");
	}
});

test("P2: petra, the core, the adapters and the tests may write", (t) => {
	const write = 'await tx.query("INSERT INTO ledger (account_id) VALUES ($1)", [id]);\n';
	const result = check(t, {
		...packages,
		"packages/petra/src/w.ts": write,
		"packages/core/src/contract-tests/d.ts": write,
		"packages/adapters-postgres/src/d.ts": write,
		"apps/platform/test/w.test.ts": write,
		"apps/platform/test-workers/setup.ts": 'await c.query("TRUNCATE accounts CASCADE");\n',
	});
	assertPasses(result);
});

test("P2: a read, or the word update in a comment, is not a write", (t) => {
	const result = check(t, {
		...packages,
		"packages/gate/src/a.ts": '// Update the list of rules.\nconst q = "SELECT * FROM rules";\n',
	});
	assertPasses(result);
});
