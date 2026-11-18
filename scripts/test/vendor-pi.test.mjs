import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { readSums, sha256 } from "../vendor-pi.mjs";

const vendorDir = join(import.meta.dirname, "..", "..", "vendor", "pi");

test("each vendored pi package has the hash in SHA256SUMS", () => {
	const sums = readSums(vendorDir);
	const files = readdirSync(vendorDir).filter((file) => file.endsWith(".tgz"));
	assert.equal(files.length, 6);
	assert.deepEqual([...sums.keys()].sort(), files.sort());
	for (const file of files) {
		assert.equal(sha256(join(vendorDir, file)), sums.get(file), file);
	}
});
