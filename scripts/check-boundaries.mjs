#!/usr/bin/env node

// The boundary checks C2, C3, C4 and P2 (docs/PRD.md, section 8).
// The script reads the source files and finds each import specifier.
// The first argument is the root directory. The default is the current directory.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { sourceFiles } from "./source-files.mjs";

const ROOT = resolve(process.argv[2] ?? process.cwd());
const SCOPE = "@tensquads/";

// These packages are shared. All other folders in packages/ are plug-ins.
const SHARED_PACKAGES = new Set(["core", "contracts", "bots"]);

// C4: business packages must not import these modules.
// A name that ends with "/" is a scope. It matches each package in the scope.
// A different name matches the package and its subpaths: "pg" matches "pg/lib", but not "pgx".
const FORBIDDEN_IN_BUSINESS = [
	// Database libraries.
	"pg",
	"postgres",
	"@neondatabase/",
	"drizzle-orm",
	"kysely",
	"@prisma/",
	"prisma",
	"mysql2",
	"better-sqlite3",
	// Model providers.
	"openai",
	"@anthropic-ai/",
	"@google/genai",
	"@google/generative-ai",
	"@mistralai/",
	"groq-sdk",
	// Other outside services.
	"stripe",
	"@aws-sdk/",
	"twilio",
	"@slack/",
	"cloudflare",
	"@cloudflare/",
	"resend",
	"@sendgrid/",
];

// Each pattern captures the specifier in group 1.
// The patterns do not skip comments. An import in a comment counts as an import.
const SPECIFIER_PATTERNS = [
	// import ... from "x", import type ... from "x", export ... from "x".
	/\bfrom\s*["']([^"'\n]+)["']/g,
	// import "x".
	/\bimport\s*["']([^"'\n]+)["']/g,
	// import("x").
	/\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
	// require("x").
	/\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
];

function findSpecifiers(text) {
	const specifiers = new Set();
	for (const pattern of SPECIFIER_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			specifiers.add(match[1]);
		}
	}
	return [...specifiers];
}

function matchesModule(specifier, name) {
	if (name.endsWith("/")) {
		return specifier.startsWith(name);
	}
	return specifier === name || specifier.startsWith(`${name}/`);
}

function packageFolders() {
	const dir = join(ROOT, "packages");
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
}

const plugins = new Set(packageFolders().filter((name) => !SHARED_PACKAGES.has(name)));

// The folder name of the package, or null for a file that is not in packages/.
function packageOf(relativePath) {
	const parts = relativePath.split(sep);
	return parts[0] === "packages" && parts.length > 2 ? parts[1] : null;
}

function isBusinessPackage(name) {
	return name !== "core" && !name.startsWith("adapters-");
}

// C2 for a relative import: the target must stay in the folder of the package.
function checkRelative(file, owner, specifier) {
	const target = relative(join(ROOT, "packages", owner), resolve(dirname(file), specifier));
	const leaves = target === ".." || target.startsWith(`..${sep}`);
	return leaves ? `relative import "${specifier}" leaves packages/${owner}` : null;
}

// C2 for a package import: the target must not be another plug-in.
function checkPackage(owner, specifier) {
	const target = specifier.slice(SCOPE.length).split("/")[0];
	return target !== owner && plugins.has(target) ? `imports the plug-in "${specifier}"` : null;
}

function checkC2(file, owner, specifier) {
	if (specifier.startsWith(".")) {
		return checkRelative(file, owner, specifier);
	}
	return specifier.startsWith(SCOPE) ? checkPackage(owner, specifier) : null;
}

function checkC3(owner, specifier) {
	if (owner !== "core" && matchesModule(specifier, "cordis")) {
		return `imports "${specifier}"; only packages/core may import cordis`;
	}
	return null;
}

function checkC4(owner, specifier) {
	if (owner === null || !isBusinessPackage(owner)) {
		return null;
	}
	const name = FORBIDDEN_IN_BUSINESS.find((forbidden) => matchesModule(specifier, forbidden));
	if (name !== undefined) {
		return `business package imports "${specifier}" (forbidden: ${name})`;
	}
	return null;
}

// P2: only the petra package writes to the database. The core (the port and its contract tests) and the
// adapters-* packages hold SQL for the port itself. Test folders are not runtime code, so the rule reads src/ only.
const SQL_WRITE = /\b(INSERT\s+INTO|UPDATE\s+[\w."]+\s+SET|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO)\b/i;

const mayWrite = (owner) => owner === "petra" || owner === "core" || Boolean(owner?.startsWith("adapters-"));

function checkP2(relativePath, owner, text) {
	if (mayWrite(owner) || !relativePath.split(sep).includes("src")) {
		return null;
	}
	const match = text.match(SQL_WRITE);
	return match ? `writes to the database ("${match[1]}"); only packages/petra may write` : null;
}

const violations = { C2: [], C3: [], C4: [], P2: [] };

for (const file of sourceFiles(ROOT)) {
	const relativePath = relative(ROOT, file);
	const owner = packageOf(relativePath);
	const text = readFileSync(file, "utf8");
	const p2 = checkP2(relativePath, owner, text);
	if (p2) violations.P2.push(`${relativePath}: ${p2}`);
	for (const specifier of findSpecifiers(text)) {
		const c2 = owner === null ? null : checkC2(file, owner, specifier);
		const c3 = checkC3(owner, specifier);
		const c4 = checkC4(owner, specifier);
		if (c2) violations.C2.push(`${relativePath}: ${c2}`);
		if (c3) violations.C3.push(`${relativePath}: ${c3}`);
		if (c4) violations.C4.push(`${relativePath}: ${c4}`);
	}
}

const descriptions = {
	C2: "no plug-in imports another plug-in",
	C3: "only the core imports cordis",
	C4: "no business package imports a database library or an SDK of an outside service",
	P2: "only the petra package writes to the database",
};

let failed = false;
for (const [rule, messages] of Object.entries(violations)) {
	for (const message of messages) {
		console.error(`${rule}: ${message}`);
		failed = true;
	}
}

if (failed) {
	process.exit(1);
}

for (const [rule, description] of Object.entries(descriptions)) {
	console.log(`${rule} passed: ${description}.`);
}
