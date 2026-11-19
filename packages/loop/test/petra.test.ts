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

test("M9: Petra removes the text of a forgotten fact from her next model request", { timeout: 30_000 }, async (t) => {
	const { storage, close } = fakeStorage();
	const fact = "The code of the safe is 4471.";
	const forgotten: string[] = [];
	const requests: string[][] = [];
	let answered: () => void = () => {};
	const loop = await openPetraLoop({
		storage,
		tools: [],
		// A recording model: it keeps the text of each request.
		complete: async ({ messages }): Promise<ModelAnswer> => {
			requests.push(messages.map((message) => message.content));
			answered();
			return text("Noted.");
		},
		forgotten: async () => forgotten,
	});
	t.after(async () => {
		await loop.close();
		close();
	});
	const turn = async (requestId: string, input: string) => {
		const done = new Promise<void>((resolve) => {
			answered = resolve;
		});
		await loop.submit(requestId, input);
		await done;
	};
	await turn("command-1", `remember on customers: ${fact}`);
	assert.ok(
		requests[0]?.some((content) => content.includes(fact)),
		"Control: the first request has the text.",
	);
	// The owner forgets the fact. The conversation still has the text, but the model request does not.
	forgotten.push(fact);
	await turn("command-2", "What do you know?");
	const next = requests[1] ?? [];
	assert.ok(next.length > 0);
	assert.ok(
		next.every((content) => !content.includes(fact)),
		"The next request has no text of the fact.",
	);
	assert.ok(next.some((content) => content.includes("remember on customers: [removed]")));
});

test("M8: a new conversation of Petra starts from the history only; the old one stays; idle tells a run in progress", {
	timeout: 30_000,
}, async (t) => {
	const { storage, close } = fakeStorage();
	const requests: string[][] = [];
	let answered: () => void = () => {};
	let hold: Promise<void> = Promise.resolve();
	const loop = await openPetraLoop({
		storage,
		tools: [],
		complete: async ({ messages }): Promise<ModelAnswer> => {
			requests.push(messages.map((message) => message.content));
			await hold;
			answered();
			return text("Noted.");
		},
	});
	t.after(close);
	const turn = async (submit: () => Promise<void>) => {
		const done = new Promise<void>((resolve) => {
			answered = resolve;
		});
		await submit();
		await done;
		for (let i = 0; i < 50 && !(await loop.idle()); i++) await new Promise((resolve) => setTimeout(resolve, 20));
	};
	await turn(() => loop.submit("command-1", "The old secret is 1234."));
	assert.equal(await loop.idle(), true, "No run and no input in the queue: Petra is idle.");
	const oldId = loop.conversationId();
	const newId = await (async () => {
		let id = 0;
		await turn(async () => {
			id = await loop.renew("renew-1", "The earlier messages of the owner:\n- Hello.");
		});
		return id;
	})();
	assert.notEqual(newId, oldId);
	assert.equal(loop.conversationId(), newId);
	await turn(() => loop.submit("command-2", "What do you know?"));
	const last = requests.at(-1) ?? [];
	assert.ok(
		last.some((content) => content.includes("Hello.")),
		"The new conversation has the history.",
	);
	assert.ok(
		last.every((content) => !content.includes("1234")),
		"The new conversation has no text of the old one.",
	);
	// A run in progress: Petra is not idle.
	let release: () => void = () => {};
	hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	const done = new Promise<void>((resolve) => {
		answered = resolve;
	});
	await loop.submit("command-3", "One more.");
	for (let i = 0; i < 50 && requests.length < 4; i++) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(await loop.idle(), false);
	release();
	await done;
	// A loop that opens again with the id uses the new conversation.
	await loop.close();
	const again = await openPetraLoop({
		storage,
		tools: [],
		complete: async () => text("Again."),
		conversationId: newId,
	});
	assert.equal(again.conversationId(), newId);
	await again.close();
});
