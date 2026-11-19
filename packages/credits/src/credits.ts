// The credits of an account (docs/ARCHITECTURE.md, section 7.6, requirements T1 to T4).
// A credit is what the owner pays. A task has one price: the price of its task type, from the bot definition.
// This package holds the rules. Petra writes the ledger rows. The balance is a query on the ledger.
import { testBot } from "@tensquads/bots";
import type { BotDefinition } from "@tensquads/contracts";

// The cause of a cancel. The owner cancels with the tool "stop a task" or with CancelTask.
// Petra cancels for a deletion that is due (section 7.7).
type CancelCause = "owner" | "deletion";

// The part of the writers of Petra that the credits use. Each write has a key from the task.
interface CreditsStore {
	// The sum of the rows of the ledger. No column holds it (requirement T4).
	balance(): Promise<number>;
	// The ledger row has the key "task/{taskId}/charge".
	chargeTask(charge: { taskId: string; credits: number; at: string }): Promise<void>;
	// The ledger row has the key "task/{taskId}/giveback".
	giveBack(refund: { taskId: string; credits: number; at: string }): Promise<void>;
}

interface CreditsDeps {
	store: CreditsStore;
	// The definitions of the bots. The default is the test bot.
	bots?: readonly BotDefinition[];
}

// A task of one bot, with its task type.
interface PricedTask {
	taskId: string;
	bot: string;
	taskType: string;
}

interface Credits {
	// True when the balance is not lower than the price of the task type (requirement T1).
	sufficient(bot: string, taskType: string): Promise<boolean>;
	// One "charge" row with the price of the task type (requirement T2).
	charge(task: PricedTask, at: string): Promise<void>;
	// One "give back" row with the price of the task type (requirement T3).
	giveBack(task: PricedTask, at: string): Promise<void>;
	// True when a cancel gives the credits back (requirement T3).
	cancelGivesBack(cause: CancelCause, runnerStarted: boolean): boolean;
}

export function credits(deps: CreditsDeps): Credits {
	const bots = deps.bots ?? [testBot];

	// The price does not change with the number of attempts or of model calls.
	function priceOf(bot: string, taskType: string): number {
		const found = bots.find((item) => item.id === bot)?.taskTypes.find((item) => item.name === taskType);
		if (!found) throw new Error(`The bot "${bot}" has no task type "${taskType}".`);
		return found.price;
	}

	return {
		sufficient: async (bot, taskType) => (await deps.store.balance()) >= priceOf(bot, taskType),
		charge: (task, at) =>
			deps.store.chargeTask({ taskId: task.taskId, credits: priceOf(task.bot, task.taskType), at }),
		giveBack: (task, at) =>
			deps.store.giveBack({ taskId: task.taskId, credits: priceOf(task.bot, task.taskType), at }),
		// A cancel for a deletion always gives back. A cancel of the owner gives back only before a runner started.
		cancelGivesBack: (cause, runnerStarted) => cause === "deletion" || !runnerStarted,
	};
}
