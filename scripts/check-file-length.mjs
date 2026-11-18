import { readFileSync } from "node:fs";
import { relative } from "node:path";

import { sourceFiles } from "./source-files.mjs";

const MAX_LINES = Number(process.env.MAX_FILE_LINES ?? 600);

const ROOT = process.cwd();

function countLines(text) {
	return text === "" ? 0 : text.split("\n").length;
}

let failed = false;

for (const file of sourceFiles(ROOT)) {
	const lines = countLines(readFileSync(file, "utf8"));
	if (lines > MAX_LINES) {
		console.error(`File too long: ${relative(ROOT, file)} has ${lines} lines (max ${MAX_LINES})`);
		failed = true;
	}
}

if (failed) {
	process.exit(1);
}

console.log(`File length check passed (max ${MAX_LINES} lines).`);
