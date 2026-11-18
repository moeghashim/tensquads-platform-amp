#!/usr/bin/env node
// Builds the pi packages that pi-durable needs, from one exact commit of earendil-works/pi.
// The npm release 1.5.2 of pi-durable has no signals, and a tool cannot park (task 01, SP-B8).
// Thus the build pins an unreleased commit of pi main. Replace this with the npm release when it has signals.
//
// Usage: node scripts/vendor-pi.mjs
// It builds the packages and writes them and SHA256SUMS to vendor/pi. The pi-ai build fetches its model data
// from the network, so a later build can differ. The test of scripts/test checks the files against SHA256SUMS.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PI_REPO = "https://github.com/earendil-works/pi.git";
const PI_COMMIT = "f6d0c2f9b6ffbcb00c5da52e7e88570539c78bde";
// The order of the build. Each package needs only the packages before it.
const PACKAGES = ["schema", "telemetry", "chord", "codemode", "ai", "durable"];

const vendorDir = join(import.meta.dirname, "..", "vendor", "pi");

export function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Reads SHA256SUMS: one "<hash>  <file>" line for each tarball.
export function readSums(dir = vendorDir) {
	const sums = new Map();
	for (const line of readFileSync(join(dir, "SHA256SUMS"), "utf8").split("\n")) {
		const match = line.match(/^([0-9a-f]{64}) {2}(\S+)$/);
		if (match) sums.set(match[2], match[1]);
	}
	return sums;
}

function run(command, args, cwd) {
	execFileSync(command, args, { cwd, stdio: ["ignore", "ignore", "inherit"] });
}

function build() {
	const work = mkdtempSync(join(tmpdir(), "vendor-pi-"));
	const source = join(work, "pi");
	const out = join(work, "out");
	run("git", ["init", "-q", source], work);
	run("git", ["fetch", "-q", "--depth", "1", PI_REPO, PI_COMMIT], source);
	run("git", ["checkout", "-q", "FETCH_HEAD"], source);
	run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], source);
	run("mkdir", ["-p", out], work);
	for (const name of PACKAGES) {
		const dir = join(source, "packages", name);
		// pi-ai makes its model data first. The other packages only compile.
		if (name === "ai") run("npm", ["run", "build"], dir);
		else run("npx", ["tsc", "-p", "tsconfig.build.json"], dir);
		run("npm", ["pack", "--silent", "--pack-destination", out], dir);
	}
	return out;
}

function main() {
	const out = build();
	const files = readdirSync(out)
		.filter((file) => file.endsWith(".tgz"))
		.sort();
	for (const file of files) copyFileSync(join(out, file), join(vendorDir, file));
	writeFileSync(join(vendorDir, "SHA256SUMS"), files.map((file) => `${sha256(join(out, file))}  ${file}\n`).join(""));
	console.log(`vendor-pi: wrote ${files.length} packages of ${PI_COMMIT}.`);
}

if (process.argv[1] === import.meta.filename) main();
