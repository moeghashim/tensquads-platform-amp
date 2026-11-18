import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import type { ModelAnswer } from "@tensquads/core";

import { type DurableObjectSqliteStorage, openPetraLoop } from "../src/petra.js";
import { text, toolCall } from "./fake-link.js";

type SqlValue = ArrayBuffer | string | number | null;

// The SQL storage of a Durable Object, on node:sqlite in memory. It has the parts that pi-durable uses.
function fakeStorage(): { storage: DurableObjectSqliteStorage; close(): void } {
	const db = new DatabaseSync(":memory:");
	const toRow = (row: Record<string, unknown>): Record<string, SqlValue> =>
		Object.fromEntries(
			Object.entries(row).map(([key, value]) => [
				key,
				value instanceof Uint8Array
					? value.slice().buffer
					: typeof value === "bigint"
						? Number(value)
						: (value as SqlValue),
			]),
		);
	const exec = (query: string, ...bindings: SqlValue[]) => {
		let rows: Record<string, SqlValue>[];
		try {
			const statement = db.prepare(query);
			const params = bindings.map(
				(value): SQLInputValue => (value instanceof ArrayBuffer ? new Uint8Array(value) : value),
			);
			rows = statement.columns().length > 0 ? statement.all(...params).map((row) => toRow(row)) : [];
			if (statement.columns().length === 0) statement.run(...params);
		} catch (error) {
			// A Durable Object runs a text with several statements. node:sqlite prepares one statement only.
			if (bindings.length > 0) throw error;
			db.exec(query);
			rows = [];
		}
		let index = 0;
		return {
			next: () => {
				const value = rows[index++];
				return value === undefined ? ({ done: true } as const) : ({ value } as const);
			},
			toArray: () => rows.slice(index),
		};
	};
	const storage: DurableObjectSqliteStorage = {
		sql: { exec },
		async transaction(closure) {
			db.exec("BEGIN");
			try {
				const value = await closure();
				db.exec("COMMIT");
				return value;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	};
	return { storage, close: () => db.close() };
}

test("Petra: an owner message runs a tool one time, and a second submit of the same request id is dropped", {
	timeout: 30_000,
}, async (t) => {
	const { storage, close } = fakeStorage();
	const toolRuns: string[] = [];
	const wakes: (number | undefined)[] = [];
	let answered: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		answered = resolve;
	});
	let modelCalls = 0;
	const loop = await openPetraLoop({
		storage,
		tools: [
			{
				name: "start_task",
				description: "Start a task.",
				execute: async (input) => {
					toolRuns.push(String(input.goal));
					return "task-1 started";
				},
			},
		],
		complete: async ({ messages }): Promise<ModelAnswer> => {
			modelCalls += 1;
			if (messages.some((m) => m.role === "tool")) {
				answered();
				return text("The task runs.");
			}
			return toolCall("c-1", "start_task", { goal: "answer" });
		},
		wakeChanged: (at) => wakes.push(at),
	});
	t.after(async () => {
		await loop.close();
		close();
	});
	await loop.submit("command-1", "Answer the customer.");
	await done;
	await loop.submit("command-1", "Answer the customer.");
	// The answer commit and the idle wake come after the last model call.
	for (let i = 0; i < 50 && loop.nextWake() !== undefined; i++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.deepEqual(toolRuns, ["answer"]);
	assert.equal(modelCalls, 2);
	assert.equal(loop.nextWake(), undefined);
	assert.ok(wakes.length > 0);
	// The alarm handler can call onWake when nothing is due.
	loop.onWake();
});
