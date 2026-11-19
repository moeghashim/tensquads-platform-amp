// The logic of the Platform object (docs/ARCHITECTURE.md, section 6.2).
// It handles the admin commands. The Durable Object class gives the call to the Petra of an account.
import type { AdminCommand, ApiError, Command } from "@tensquads/contracts";

import type { PlatformReader, PlatformWriter, SharedCostPart } from "./platform-writer.js";

export interface PlatformDeps {
	writer: PlatformWriter & PlatformReader;
	// Sends a command to the Petra of an account, and waits for "accepted".
	sendToPetra: (accountId: string, command: Command) => Promise<void>;
	// The division of a shared cost (packages/costs). This package does not import it (requirement C2).
	divide?: (amount: number, usages: readonly { accountId: string; usage: number }[]) => SharedCostPart[];
}

type SetSharedCost = Extract<AdminCommand, { type: "SetSharedCost" }>;
type Share = { id: string; period: string; kind: SetSharedCost["kind"]; provider: string };

export type AdminAnswer = { status: "accepted"; commandId: string } | ApiError;

// The four admin commands (section 6.2).
export const PLATFORM_HANDLES = ["CreateAccount", "AddOwner", "SetUnitPrice", "SetSharedCost"] as const;

export interface PlatformObject {
	// Writes the command to admin_commands first. A command id that comes again gets the same answer (P4).
	accept(command: AdminCommand, adminRef: string): Promise<AdminAnswer>;
	// After a start: runs each "received" command again from its start.
	recover(): Promise<void>;
}

export function platformObject(deps: PlatformDeps): PlatformObject {
	const { writer } = deps;
	let running: Promise<unknown> = Promise.resolve();

	// Sends one AddCostShare to each account. The command id is the shared-cost id and the account id.
	// A cancel row has the old part as a negative amount, and its command id ends with "/cancel" (section 7.6).
	async function sendShares(share: Share, parts: readonly SharedCostPart[], at: string, cancel: boolean) {
		for (const part of parts) {
			await deps.sendToPetra(part.accountId, {
				type: "AddCostShare",
				commandId: `${share.id}/${part.accountId}${cancel ? "/cancel" : ""}`,
				at,
				sharedCostId: share.id,
				period: share.period,
				kind: share.kind,
				provider: share.provider,
				amount: cancel ? -part.amount : part.amount,
			});
		}
	}

	// The parts are written before a share is sent. A command that runs again reads them (requirement S4).
	async function partsOf(command: SetSharedCost): Promise<SharedCostPart[]> {
		const saved = await writer.sharedCostParts(command.commandId);
		if (saved.length > 0 || !deps.divide) return saved;
		const usages = await writer.periodUsage(command.period);
		const used = usages.filter((item) => item.usage > 0);
		// With usage, only the accounts with usage get a part. With no usage, each account gets an equal part.
		await writer.addSharedCostParts(command.commandId, deps.divide(command.amount, used.length > 0 ? used : usages));
		return writer.sharedCostParts(command.commandId);
	}

	// A correction names the old amount. An amount is corrected one time only (section 7.2). Returns the old share,
	// or an error. A command with no correction has no old share.
	async function oldShareOf(command: SetSharedCost): Promise<Share | ApiError | undefined> {
		const id = command.supersedes;
		if (id === undefined) return undefined;
		const old = await writer.sharedCost(id);
		if (!old) return { code: "not_found", message: "The old shared cost does not exist." };
		if (old.supersededBy && old.supersededBy !== command.commandId) {
			return { code: "conflict", message: "The old shared cost has a correction already." };
		}
		return { id, period: old.period, kind: old.kind, provider: old.provider };
	}

	// Adds the shared cost, writes its parts, then sends the cancel rows of the old parts and the new parts (S4, S5).
	async function sharedCost(command: SetSharedCost, adminRef: string): Promise<AdminAnswer | undefined> {
		const old = await oldShareOf(command);
		if (old && "code" in old) return old;
		const { commandId: id, period, kind, provider, amount, at } = command;
		const supersedes = command.supersedes ?? null;
		await writer.addSharedCost({ id, period, kind, provider, amount, supersedes, setBy: adminRef, at });
		const parts = await partsOf(command);
		if (old) await sendShares(old, await writer.sharedCostParts(old.id), at, true);
		await sendShares({ id, period, kind, provider }, parts, at, false);
		return undefined;
	}

	// The account id is the command id of CreateAccount. The GrantCredits id is made from it.
	async function handle(command: AdminCommand, adminRef: string): Promise<AdminAnswer> {
		if (command.type === "SetUnitPrice") {
			const { provider, model, unit, price, startsAt } = command;
			await writer.addUnitPrice({ provider, model, unit, price, startsAt });
		} else if (command.type === "SetSharedCost") {
			const refused = await sharedCost(command, adminRef);
			if (refused) return refused;
		} else if (command.type === "CreateAccount") {
			const accountId = command.commandId;
			await writer.addAccount({
				id: accountId,
				name: command.name,
				timeZone: command.timeZone,
				language: command.language,
				modelProfile: command.modelProfile,
				at: command.at,
			});
			if (command.initialCredits) {
				await deps.sendToPetra(accountId, {
					type: "GrantCredits",
					commandId: `${command.commandId}/grant`,
					at: command.at,
					credits: command.initialCredits,
				});
			}
		} else if (command.type === "AddOwner") {
			if (!(await writer.accountExists(command.accountId))) {
				return { code: "not_found", message: "The account does not exist." };
			}
			await writer.addOwner({ accountId: command.accountId, identityRef: command.identityRef, at: command.at });
		}
		return { status: "accepted", commandId: command.commandId };
	}

	async function run(command: AdminCommand, adminRef: string): Promise<AdminAnswer> {
		const answer = await handle(command, adminRef);
		await writer.finishAdminCommand(command.commandId, answer);
		return answer;
	}

	function serial<T>(work: () => Promise<T>): Promise<T> {
		const next = running.then(work, work);
		running = next.catch(() => undefined);
		return next;
	}

	return {
		accept: (command, adminRef) =>
			serial(async () => {
				const row = await writer.receiveAdminCommand({
					commandId: command.commandId,
					kind: command.type,
					payload: command,
					adminRef,
					at: command.at,
				});
				return row.status === "done" ? (row.answer as AdminAnswer) : run(command, adminRef);
			}),
		recover: () =>
			serial(async () => {
				for (const row of await writer.receivedAdminCommands()) {
					await run(row.payload as AdminCommand, row.adminRef);
				}
			}),
	};
}

// One row of the operations view (requirement S7).
export interface OperationsRow {
	item: string;
	account_id: string | null;
	ref: string | null;
	at: string | null;
	count: number | string;
}

// A request for a sandbox in the list of the Platform object.
export interface ListedRequest {
	accountId: string;
	taskId: string;
	attemptNo: number;
	putAt: number;
	takenAt?: number;
}

// The SQL view gives each open task with its last trail time. A task is stuck when it has no trail row for longer
// than the maximum time of one attempt. A request is stuck when no launcher took it in the take time (section 7.6).
export function operationsRows(
	rows: readonly OperationsRow[],
	requests: readonly ListedRequest[],
	now: number,
	limits: { attemptMaxMs: number; takeTimeMs: number },
): OperationsRow[] {
	const stuck = rows.flatMap((row) => {
		if (row.item !== "open task") return [row];
		const quiet = row.at === null || now - Date.parse(row.at) > limits.attemptMaxMs;
		return quiet ? [{ ...row, item: "stuck task" }] : [];
	});
	const untaken = requests
		.filter((request) => request.takenAt === undefined && now - request.putAt > limits.takeTimeMs)
		.map((request) => ({
			item: "sandbox request not taken",
			account_id: request.accountId,
			ref: `${request.taskId}/${request.attemptNo}`,
			at: new Date(request.putAt).toISOString(),
			count: 1,
		}));
	return [...stuck, ...untaken];
}
