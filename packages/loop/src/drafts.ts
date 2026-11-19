import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DraftFile } from "@tensquads/contracts";

import type { Link } from "./link.js";

// The files of the tools of a bot are in a work directory in the sandbox (requirement G11, decision D9).
// After each step that changes a file, the file goes to the draft store. A new attempt loads the drafts first.

// The name of the directory of the files, inside the work directory of the loop.
export const FILES_DIR = "files";

// Gives the full path of a file of the work directory. A path that goes out of the directory is an error.
function filePath(dir: string, path: string): string {
	const full = resolve(dir, path);
	const inside = relative(resolve(dir), full);
	if (inside === "" || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) {
		throw new Error(`The path "${path}" is not inside the work directory.`);
	}
	return full;
}

// Writes each draft file into the work directory. A new attempt does this before the loop continues.
export function writeDrafts(dir: string, drafts: readonly DraftFile[]): void {
	mkdirSync(dir, { recursive: true });
	for (const draft of drafts) {
		const full = filePath(dir, draft.path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, Buffer.from(draft.body, "base64"));
	}
}

function listFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.sort();
}

// The SHA-256 of each file of the directory, by its path with "/".
function fileHashes(dir: string): Map<string, string> {
	return new Map(
		listFiles(dir).map((path) => [
			path,
			createHash("sha256")
				.update(readFileSync(join(dir, path)))
				.digest("hex"),
		]),
	);
}

// Finds the files that changed since the last check, and sends each one to `draft`.
// The checks run one after the other, so two tools of one round do not send the same file two times.
export class DraftSender {
	private known: Map<string, string>;
	private queue: Promise<void> = Promise.resolve();

	constructor(
		private readonly dir: string,
		private readonly link: Link,
	) {
		this.known = fileHashes(dir);
	}

	sendChanged(): Promise<void> {
		const next = this.queue.then(() => this.send());
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async send(): Promise<void> {
		const current = fileHashes(this.dir);
		for (const [path, hash] of current) {
			if (this.known.get(path) === hash) continue;
			await this.link.draft(path, readFileSync(join(this.dir, path)).toString("base64"));
			this.known.set(path, hash);
		}
	}
}
