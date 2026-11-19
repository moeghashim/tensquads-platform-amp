// The memory of an account (docs/ARCHITECTURE.md, sections 4.5, 7.2 and 7.7, requirements M1 to M9 and M12).
// The four layers are the record of messages (the table messages), the notes, the pages and the core.
// This package holds the rules. Petra writes the rows. This package has no Cloudflare import.
import { testBot } from "@tensquads/bots";
import type { BotDefinition, TaskResult } from "@tensquads/contracts";

import { type DayMessage, type ProposalModel, type ProposalStore, proposeDay } from "./propose.js";
import { regularText, searchQuery } from "./regular.js";

// The system sets the origin of each fact. A model or a bot never sets it (requirement M2).
export type Origin = "owner" | "bot" | "not trusted" | "system";

// At 25 active items, Petra adds no item (requirement M7, decision D10).
export const CORE_LIMIT = 25;
// At 20 active items, the night job proposes nothing (requirement M7, decision D10).
export const PROPOSE_LIMIT = 20;
// The owner can undo a forget for 30 days. Then the night job deletes the fact (requirement M8).
export const UNDO_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// The number of search results in a brief.
const BRIEF_RESULTS = 5;
const SEARCH_RESULTS = 20;

// One row that a search or the core gives: the id of the row and its text.
export interface Found {
	id: string;
	text: string;
}

export interface NewFact {
	sourceRef: string;
	page: string;
	text: string;
	// The regular text for the search column (requirement M12).
	search: string;
	origin: Origin;
	madeBy: string;
	customerRef: string | null;
	approvedByOwner: boolean;
	at: string;
}

export interface NewNote {
	sourceRef: string;
	bot: string;
	taskId: string;
	text: string;
	search: string;
	origin: Origin;
	customerRef: string | null;
	at: string;
}

export interface StoredFact {
	id: string;
	page: string;
	text: string;
	origin: Origin;
	status: "current" | "replaced" | "forgotten";
	forgottenAt: string | null;
	customerRef: string | null;
}

export interface ForgottenFact {
	id: string;
	text: string;
	forgottenAt: string;
}

export interface NewCoreItem {
	sourceRef: string;
	text: string;
	source: "owner" | "night job";
	factRef: string | null;
	customerRef: string | null;
	at: string;
}

// The rows that one search can read. The query is the output of searchQuery.
export interface SearchScope {
	query: string;
	allPages: boolean;
	pages: readonly string[];
	notes: boolean;
	limit: number;
}

// The memory writer of Petra. Each write has a key, so a second write with the same key changes nothing.
export interface MemoryStore extends ProposalStore {
	addPage(page: { name: string; acceptsFrom: string; createdBy: string }): Promise<void>;
	// The bot (or "owner") that the page accepts, or undefined when the page does not exist.
	pageAccepts(name: string): Promise<string | undefined>;
	addFact(fact: NewFact): Promise<void>;
	addNote(note: NewNote): Promise<void>;
	fact(id: string): Promise<StoredFact | undefined>;
	// Only current facts. The best rows first.
	search(scope: SearchScope): Promise<Found[]>;
	activeCore(): Promise<Found[]>;
	// Adds the item only while the core has fewer active items than the limit. True when the item is there.
	addCoreItem(item: NewCoreItem, limit: number): Promise<boolean>;
	removeCoreItem(sourceRef: string): Promise<void>;
	// Sets approved_by_owner, only when a core item was made from the fact. A promoted fact is approved (section 7.8).
	approveFact(id: string): Promise<void>;
	// Changes only a current fact. The time of the first forget stays.
	forgetFact(id: string, at: string): Promise<void>;
	// Changes only a forgotten fact.
	undoForget(id: string): Promise<void>;
	// The forgotten facts. With a time, only the facts that were forgotten before it.
	forgottenFacts(before?: string): Promise<ForgottenFact[]>;
}

// The part of the task writer of Petra that the memory uses (section 4.5).
export interface MemoryTasks {
	openTasks(): Promise<{ id: string; brief: { facts: readonly { id: string }[] } }[]>;
	addInbox(row: { taskId: string; sourceRef: string; kind: "forget"; factId: string; at: string }): Promise<void>;
}

// The message writer of Petra. It writes each message one time, by its source reference.
export type MemoryTell = (message: {
	sourceRef: string;
	channel: string;
	body: { type: "reply"; text: string };
}) => Promise<void>;

export interface MemoryDeps {
	store: MemoryStore;
	tasks: MemoryTasks;
	tell: MemoryTell;
	// The definitions of the bots. The default is the test bot.
	bots?: readonly BotDefinition[];
	// The model port, for the proposals of the night job. Without it, the night job proposes nothing.
	model?: ProposalModel;
}

// A task with a result that stands. A task with a customer reference came from an external event.
export interface ResultTask {
	taskId: string;
	attemptNo: number;
	bot: string;
	customerRef: string | null;
}

interface OwnerCommand {
	commandId: string;
	at: string;
	// The channel of the answer. The default is "chat".
	channel?: string;
}

export interface Memory {
	// The tool "remember a fact" of the owner. Returns the answer to the owner, with the id of the fact.
	rememberFact(fact: OwnerCommand & { page: string; text: string }): Promise<string>;
	// The facts and the notes of a result that stands (requirements M2 to M4).
	addResult(task: ResultTask, result: TaskResult, at: string): Promise<void>;
	// A search by words, limited by the read list (requirements M5 and M6).
	search(readList: readonly string[], text: string, limit?: number): Promise<Found[]>;
	// The facts of a brief: the active core items, then the best search results for the goal.
	briefFacts(bot: string, goal: string): Promise<Found[]>;
	addCoreItem(item: OwnerCommand & { text: string }): Promise<string>;
	// Only the owner promotes a fact to the core. A fact that is not trusted never goes into it (requirement M3).
	promoteFact(promote: OwnerCommand & { factId: string }): Promise<string>;
	removeCoreItem(item: OwnerCommand & { itemId: string }): Promise<string>;
	// True when the core has fewer than 20 active items, so the night job may propose (requirement M7).
	mayPropose(): Promise<boolean>;
	forgetFact(forget: OwnerCommand & { factId: string }): Promise<string>;
	undoForget(undo: OwnerCommand & { factId: string }): Promise<string>;
	// The texts of all forgotten facts. Petra removes them from her own model requests (requirement M9).
	forgottenTexts(): Promise<string[]>;
	// The facts that were forgotten more than 30 days before the time. The night job deletes them (M8).
	forgottenDue(now: string): Promise<ForgottenFact[]>;
	// The night job: proposals for the core from the messages of the owner of one day (requirement M10).
	// Nothing when the core has 20 items or more. Returns the number of new proposals.
	propose(day: { date: string; messages: readonly DayMessage[] }): Promise<number>;
}

const PAGE_PREFIX = "memory/pages/";

function scopeOf(readList: readonly string[], text: string, limit: number): SearchScope {
	return {
		query: searchQuery(text),
		allPages: readList.includes("memory/facts"),
		pages: readList.filter((entry) => entry.startsWith(PAGE_PREFIX)).map((entry) => entry.slice(PAGE_PREFIX.length)),
		notes: readList.includes("memory/notes"),
		limit,
	};
}

export function memory(deps: MemoryDeps): Memory {
	const { store } = deps;
	const bots = deps.bots ?? [testBot];
	const botOf = (id: string) => bots.find((bot) => bot.id === id);

	async function reply(command: OwnerCommand, text: string): Promise<string> {
		const sourceRef = `cmd/${command.commandId}/reply`;
		await deps.tell({ sourceRef, channel: command.channel ?? "chat", body: { type: "reply", text } });
		return text;
	}

	// The pages come from the definitions of the bots, at the first need. The first bot of a page keeps it (M4).
	async function ensurePages(): Promise<void> {
		for (const bot of bots) {
			for (const name of bot.factPages) await store.addPage({ name, acceptsFrom: bot.id, createdBy: "system" });
		}
	}

	async function addCore(command: OwnerCommand, item: Omit<NewCoreItem, "sourceRef" | "source" | "at">) {
		const sourceRef = `cmd/${command.commandId}/core`;
		const added = await store.addCoreItem({ ...item, sourceRef, source: "owner", at: command.at }, CORE_LIMIT);
		const text = added
			? `I added the item ${sourceRef} to the core.`
			: `The core is full: it has ${CORE_LIMIT} items. Please remove an item first.`;
		return reply(command, text);
	}

	async function search(readList: readonly string[], text: string, limit = SEARCH_RESULTS): Promise<Found[]> {
		const scope = scopeOf(readList, text, limit);
		if (scope.query === "" || (!scope.allPages && scope.pages.length === 0 && !scope.notes)) return [];
		return store.search(scope);
	}

	return {
		async rememberFact(fact) {
			await ensurePages();
			const id = `cmd/${fact.commandId}/fact`;
			// A page that no bot has belongs to the owner.
			if ((await store.pageAccepts(fact.page)) === undefined) {
				await store.addPage({ name: fact.page, acceptsFrom: "owner", createdBy: "owner" });
			}
			// A fact of the owner is a separate row. No write of a bot changes it (requirement M4).
			await store.addFact({
				sourceRef: id,
				page: fact.page,
				text: fact.text,
				search: regularText(fact.text),
				origin: "owner",
				madeBy: "owner",
				customerRef: null,
				approvedByOwner: true,
				at: fact.at,
			});
			return reply(fact, `I keep the fact ${id} on the page ${fact.page}.`);
		},

		async addResult(task, result, at) {
			const bot = botOf(task.bot);
			if (!bot) return;
			// The origin comes from the task, never from the text of the result (requirements M2 and M3).
			const origin: Origin = task.customerRef ? "not trusted" : "bot";
			const base = { origin, customerRef: task.customerRef, at };
			const [page] = bot.factPages;
			if (page && result.proposedFacts.length > 0) {
				await ensurePages();
				// A fact of a bot goes only to a page that accepts that bot (requirement M4).
				const accepts = (await store.pageAccepts(page)) === bot.id;
				for (const [n, text] of accepts ? result.proposedFacts.entries() : []) {
					const sourceRef = `task/${task.taskId}/${task.attemptNo}/fact/${n}`;
					const fact = { ...base, sourceRef, page, text, search: regularText(text), madeBy: bot.id };
					await store.addFact({ ...fact, approvedByOwner: false });
				}
			}
			for (const [n, text] of result.notes.entries()) {
				const sourceRef = `task/${task.taskId}/${task.attemptNo}/note/${n}`;
				await store.addNote({
					...base,
					sourceRef,
					bot: bot.id,
					taskId: task.taskId,
					text,
					search: regularText(text),
				});
			}
		},

		search,

		async briefFacts(botId, goal) {
			const bot = botOf(botId);
			if (!bot) return [];
			const core = bot.readList.includes("memory/core") ? await store.activeCore() : [];
			return [...core, ...(await search(bot.readList, goal, BRIEF_RESULTS))];
		},

		addCoreItem: (item) => addCore(item, { text: item.text, factRef: null, customerRef: null }),

		async promoteFact(promote) {
			const fact = await store.fact(promote.factId);
			if (fact?.status !== "current") return reply(promote, `No current fact has the id ${promote.factId}.`);
			if (fact.origin === "not trusted") {
				return reply(promote, `The fact ${fact.id} is not trusted. It cannot go into the core.`);
			}
			const answer = await addCore(promote, { text: fact.text, factRef: fact.id, customerRef: fact.customerRef });
			await store.approveFact(fact.id);
			return answer;
		},

		async removeCoreItem(item) {
			await store.removeCoreItem(item.itemId);
			return reply(item, `I removed the item ${item.itemId} from the core.`);
		},

		mayPropose: async () => (await store.activeCore()).length < PROPOSE_LIMIT,

		async forgetFact(forget) {
			const { factId, at } = forget;
			if (!(await store.fact(factId))) return reply(forget, `No fact has the id ${factId}.`);
			// The fact is hidden from each search at once (requirement M8).
			await store.forgetFact(factId, at);
			// Each open task whose brief has the fact gets it on its forget list (requirement M9, decision D11).
			for (const task of await deps.tasks.openTasks()) {
				if (!task.brief.facts.some((fact) => fact.id === factId)) continue;
				await deps.tasks.addInbox({
					taskId: task.id,
					sourceRef: `cmd/${forget.commandId}/forget`,
					kind: "forget",
					factId,
					at,
				});
			}
			return reply(forget, `I forgot the fact ${factId}. You can undo this for ${UNDO_DAYS} days.`);
		},

		async undoForget(undo) {
			const fact = await store.fact(undo.factId);
			if (fact?.status !== "forgotten" || fact.forgottenAt === null) {
				return reply(undo, `The fact ${undo.factId} is not forgotten.`);
			}
			if (Date.parse(undo.at) - Date.parse(fact.forgottenAt) > UNDO_DAYS * DAY_MS) {
				return reply(
					undo,
					`The undo is no longer possible. You forgot the fact ${fact.id} more than ${UNDO_DAYS} days ago.`,
				);
			}
			// The forget list of a running task does not change (decision D11).
			await store.undoForget(fact.id);
			return reply(undo, `The fact ${fact.id} is back.`);
		},

		forgottenTexts: async () => (await store.forgottenFacts()).map((fact) => fact.text),

		forgottenDue: (now) => store.forgottenFacts(new Date(Date.parse(now) - UNDO_DAYS * DAY_MS).toISOString()),

		async propose(day) {
			const { model } = deps;
			if (!model || (await store.activeCore()).length >= PROPOSE_LIMIT) return 0;
			return proposeDay({ store, model }, day);
		},
	};
}
