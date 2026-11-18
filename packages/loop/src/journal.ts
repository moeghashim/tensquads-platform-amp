import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// The journal of a task is a local SQLite file in the sandbox (ARCHITECTURE section 4.3).

function removeFiles(file: string): void {
	for (const path of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
		rmSync(path, { force: true });
	}
}

// Writes the copy from the gateway as the journal file. A null copy gives an empty work directory.
export function writeJournal(file: string, copy: string | null): void {
	removeFiles(file);
	if (copy !== null) {
		writeFileSync(file, Buffer.from(copy, "base64"));
	}
}

// Makes one consistent copy of the journal as base64 text.
// VACUUM INTO reads from a second connection, so the harness can stay open.
export function journalCopy(file: string): string {
	const target = `${file}.copy`;
	rmSync(target, { force: true });
	const db = new DatabaseSync(file);
	try {
		db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
	} finally {
		db.close();
	}
	const bytes = readFileSync(target);
	rmSync(target, { force: true });
	return bytes.toString("base64");
}
