// The night job of an account (docs/ARCHITECTURE.md, sections 7.7, 7.8 and 10.1, requirements M8, M10 and M13).
// The sequence: the proposals for the core, then the deletions that are due, then the old trails.
// Petra starts her new conversation after it (petra.ts). The memory and the cleaning come from packages/memory.
// This package does not import it (requirement C2). Each time comes from the clock of Petra.
import type { CleanedRow, NightWriter, TaskState } from "./night-writer.js";
import type { PetraStorage } from "./outbox.js";
import { localMidnight, monthsBefore, previousDate } from "./schedule.js";
import type { CancelCause, CancelOutcome } from "./task-work.js";

// The texts of the deleted forgotten facts. Petra keeps them out of her model requests until her next new
// conversation (requirement M8, section 7.7).
export const FORGOTTEN_KEY = "petra_forgotten";
// The data of a customer stays 12 months after the last message of that customer (decision D32).
const CUSTOMER_MONTHS = 12;
const ENDED = new Set(["done", "failed", "cancelled"]);

export interface NightMemory {
	propose(day: { date: string; messages: readonly { id: string; text: string }[] }): Promise<number>;
	forgottenDue(now: string): Promise<{ id: string; text: string }[]>;
}

// The cleaning function of packages/memory: the text with no name, address or number of the customer.
export type CleanText = (
	text: string,
	customer: { names: readonly string[]; addresses: readonly string[] },
) => { text: string; search: string };

export interface NightDeps {
	writer: NightWriter;
	memory: NightMemory;
	// The cancel of the task work, with the cause "deletion" (section 7.7, step 1).
	cancel: (taskId: string, cause: CancelCause) => Promise<CancelOutcome>;
	// The object store of the account.
	objectStore: { delete(key: string): Promise<void> };
	storage: PetraStorage;
	clean: CleanText;
	// The deletion of the old trails (packages/trail, requirement T8).
	trail: () => Promise<unknown>;
	now: () => string;
}

export interface NightJob {
	run(localDate: string): Promise<void>;
}

export async function keptForgottenTexts(storage: PetraStorage): Promise<string[]> {
	return (await storage.get<string[]>(FORGOTTEN_KEY)) ?? [];
}

// The texts that Petra removes from her model requests: the kept texts and the texts of the forgotten facts.
export async function petraForgotten(storage: PetraStorage, live: () => Promise<readonly string[]>): Promise<string[]> {
	return [...new Set([...(await keptForgottenTexts(storage)), ...(await live())])];
}

export function nightJob(deps: NightDeps): NightJob {
	const { writer } = deps;

	// Steps 1 to 3 of section 7.7. Returns false when an action of a task is "started": the deletion waits.
	async function clearTasks(tasks: readonly TaskState[]): Promise<boolean> {
		if (tasks.length === 0) return true;
		for (const task of tasks.filter((item) => !ENDED.has(item.status))) await deps.cancel(task.id, "deletion");
		const ids = tasks.map((task) => task.id);
		await writer.rejectPending(ids, deps.now());
		return (await writer.startedTasks(ids)).size === 0;
	}

	// First the objects, then the rows. If the job stops between them, the next night job deletes again.
	async function deleteFiles(blobKeys: readonly string[]): Promise<void> {
		if (blobKeys.length === 0) return;
		for (const key of new Set(blobKeys)) await deps.objectStore.delete(key);
		await writer.deleteFiles(blobKeys);
	}

	// Requirement M10: the messages of the owner of the local day that ended at the start of the local date.
	async function propose(localDate: string): Promise<void> {
		const timeZone = await writer.timeZone();
		const day = previousDate(localDate);
		const messages = await writer.ownerMessages(localMidnight(day, timeZone), localMidnight(localDate, timeZone));
		await deps.memory.propose({ date: day, messages });
	}

	// Requirement M8 and decision D11: a fact forgotten more than 30 days ago, and the journal copies of each task
	// whose brief had it. Petra keeps the text until her next new conversation.
	async function forgotten(now: string): Promise<void> {
		for (const fact of await deps.memory.forgottenDue(now)) {
			const tasks = await writer.tasksWithFact(fact.id);
			if (!(await clearTasks(tasks))) continue;
			const kept = await keptForgottenTexts(deps.storage);
			if (!kept.includes(fact.text)) await deps.storage.put(FORGOTTEN_KEY, [...kept, fact.text]);
			await deleteFiles(await writer.journalCopies(tasks.map((task) => task.id)));
			await writer.deleteForgottenFacts([fact.id]);
		}
	}

	// Section 7.8: each customer whose newest message is older than 12 months.
	async function customers(now: string): Promise<void> {
		for (const customerRef of await writer.dueCustomers(monthsBefore(now, CUSTOMER_MONTHS))) {
			const tasks = await writer.customerTasks(customerRef);
			if (!(await clearTasks(tasks))) continue;
			const taskIds = tasks.map((task) => task.id);
			await deleteFiles(await writer.taskFiles(taskIds));
			// The names and the addresses come from the events, before the cleaning empties them.
			const data = await writer.customerData(customerRef);
			const facts: CleanedRow[] = (await writer.keptFacts(customerRef)).map((fact) => ({
				id: fact.id,
				...deps.clean(fact.text, data),
			}));
			const core: CleanedRow[] = (await writer.customerCore(customerRef)).map((item) => ({
				id: item.id,
				text: deps.clean(item.text, data).text,
			}));
			// Each fact that is deleted or cleaned, and each cleaned core item: the cleaned text for the briefs.
			const briefs: CleanedRow[] = [
				...(await writer.customerFacts(customerRef)).map((fact) => ({
					id: fact.id,
					text: deps.clean(fact.text, data).text,
				})),
				...core,
			];
			await writer.cleanCustomer({ customerRef, taskIds, facts, core, briefs, at: now });
		}
	}

	return {
		async run(localDate) {
			const now = deps.now();
			await propose(localDate);
			await forgotten(now);
			// Section 7.7: the drafts and the journal copies of each task with a final status.
			await deleteFiles(await writer.endedTaskFiles());
			await customers(now);
			await deps.trail();
		},
	};
}
