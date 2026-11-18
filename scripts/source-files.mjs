// The source files that the repository checks read: the code files under apps/ and packages/.
// The walk skips folders of dependencies and of build output.
import { globSync } from "node:fs";
import { basename, join } from "node:path";

const SOURCE_PATTERNS = ["apps/**/*.{ts,tsx,js,mjs}", "packages/**/*.{ts,tsx,js,mjs}"];
const EXCLUDE_DIR_NAMES = new Set(["node_modules", "dist", "build", ".git", ".next", ".open-next", ".wrangler"]);

// Returns the absolute path of each source file under the root directory.
export function sourceFiles(root) {
	return globSync(SOURCE_PATTERNS, { cwd: root, exclude: (path) => EXCLUDE_DIR_NAMES.has(basename(path)) }).map(
		(path) => join(root, path),
	);
}
