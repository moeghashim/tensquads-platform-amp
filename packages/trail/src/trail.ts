// The trail of the tasks of an account (docs/ARCHITECTURE.md, sections 7.2, 7.4 and 7.7, requirements T5 to T8).
// Each step of each task is one row. A large item goes to the object store, and the row keeps its key and hash.
// This package holds the rules. Petra writes the rows. This package has no Cloudflare import.
import type { ObjectStore } from "@tensquads/core";

// The data of a row is larger than this, in UTF-8 bytes: it goes to the object store (requirement T7).
const LARGE_ITEM_BYTES = 16 * 1024;
// The key part of an item of a row with no task.
const NO_TASK = "no-task";

// One step, as a caller gives it. The kind is the trail kind of Petra.
type TrailStep<K extends string> = {
	sourceRef: string;
	taskId: string | null;
	attemptNo: number | null;
	turnNo: number | null;
	kind: K;
	actor: string;
	summary: string;
	data?: unknown;
	at: string;
};

// The part of a stored row that this package reads.
interface StoredRow {
	data: unknown;
	blobKey: string | null;
}

// The trail writer of Petra. Each write has a source reference as its key.
interface TrailStore<K extends string, R extends StoredRow, T extends StoredRow> {
	addTrail(row: TrailStep<K> & { blobKey: string | null; blobHash: string | null }): Promise<void>;
	trailRow(sourceRef: string): Promise<R | undefined>;
	// All the rows of one task in the sequence of seq, with each attempt (requirement T6).
	taskTrail(taskId: string): Promise<T[]>;
	// The rows that the retention rule of the database allows to delete (requirement T8).
	expiredTrail(): Promise<{ sourceRef: string; blobKey: string | null }[]>;
	deleteTrail(sourceRefs: readonly string[]): Promise<number>;
}

interface TrailDeps<K extends string, R extends StoredRow, T extends StoredRow> {
	store: TrailStore<K, R, T>;
	// The object store of the account. Its adapter adds the prefix "accounts/{accountId}/" (section 7.4).
	objectStore: Pick<ObjectStore, "put" | "get" | "delete">;
}

export interface Trail<K extends string, R extends StoredRow, T extends StoredRow> {
	// Adds one row. A row that is there does not change.
	add(row: TrailStep<K>): Promise<void>;
	// One row, with the data of its item when the item is in the object store.
	row(sourceRef: string): Promise<R | undefined>;
	// The full trail of one task, from the message of the owner to the last result (requirement T6).
	taskTrail(taskId: string): Promise<T[]>;
	// The night job: first the items in the object store, then the rows. Returns the number of deleted rows.
	night(): Promise<number>;
}

async function sha256Hex(text: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function trail<K extends string, R extends StoredRow, T extends StoredRow>(
	deps: TrailDeps<K, R, T>,
): Trail<K, R, T> {
	const { store, objectStore } = deps;

	// The item of a row is JSON in the object store. A missing item is an error: the row keeps its link.
	async function withItem<S extends StoredRow>(row: S): Promise<S> {
		if (row.blobKey === null) return row;
		const body = await objectStore.get(row.blobKey);
		if (body === undefined) throw new Error(`The trail item "${row.blobKey}" is not in the object store.`);
		return { ...row, data: JSON.parse(body) };
	}

	return {
		async add(row) {
			const { data, ...step } = row;
			const json = data === undefined ? undefined : JSON.stringify(data);
			if (json === undefined || new TextEncoder().encode(json).byteLength <= LARGE_ITEM_BYTES) {
				return store.addTrail({ ...row, blobKey: null, blobHash: null });
			}
			// The key has the hash, so a second write puts the same item at the same key.
			const blobHash = await sha256Hex(json);
			// The rows of one task expire together, so they can share an item. A row with no task expires alone, so its
			// key also has the hash of its source reference. Thus the night job never deletes the item of a newer row.
			const blobKey =
				row.taskId === null
					? `trail/${NO_TASK}/${await sha256Hex(row.sourceRef)}/${blobHash}`
					: `trail/${row.taskId}/${blobHash}`;
			await objectStore.put(blobKey, json);
			await store.addTrail({ ...step, blobKey, blobHash });
		},
		row: async (sourceRef) => {
			const found = await store.trailRow(sourceRef);
			return found ? withItem(found) : undefined;
		},
		taskTrail: async (taskId) => Promise.all((await store.taskTrail(taskId)).map(withItem)),
		async night() {
			const expired = await store.expiredTrail();
			if (expired.length === 0) return 0;
			// If the job stops after this step, the rows are still there. The next night job deletes again.
			const keys = new Set(expired.flatMap((row) => (row.blobKey === null ? [] : [row.blobKey])));
			for (const key of keys) await objectStore.delete(key);
			return store.deleteTrail(expired.map((row) => row.sourceRef));
		},
	};
}
