// The logic of the Platform object (docs/ARCHITECTURE.md, section 6.2).
// It handles the admin commands. The Durable Object class gives the call to the Petra of an account.
import type { AdminCommand, ApiError, Command } from "@tensquads/contracts";

import type { PlatformReader, PlatformWriter } from "./platform-writer.js";

export interface PlatformDeps {
	writer: PlatformWriter & PlatformReader;
	// Sends a command to the Petra of an account, and waits for "accepted".
	sendToPetra: (accountId: string, command: Command) => Promise<void>;
}

export type AdminAnswer = { status: "accepted"; commandId: string } | ApiError;

// The admin commands of this task. SetUnitPrice and SetSharedCost come in task 10.
export const PLATFORM_HANDLES = ["CreateAccount", "AddOwner"] as const;

export interface PlatformObject {
	// Writes the command to admin_commands first. A command id that comes again gets the same answer (P4).
	accept(command: AdminCommand, adminRef: string): Promise<AdminAnswer>;
	// After a start: runs each "received" command again from its start.
	recover(): Promise<void>;
}

export function platformObject(deps: PlatformDeps): PlatformObject {
	const { writer } = deps;
	let running: Promise<unknown> = Promise.resolve();

	// The account id is the command id of CreateAccount. The GrantCredits id is made from it.
	async function handle(command: AdminCommand): Promise<AdminAnswer> {
		if (command.type === "CreateAccount") {
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
		} else {
			return { code: "not_available", message: "This command is not available yet." };
		}
		return { status: "accepted", commandId: command.commandId };
	}

	async function run(command: AdminCommand): Promise<AdminAnswer> {
		const answer = await handle(command);
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
				return row.status === "done" ? (row.answer as AdminAnswer) : run(command);
			}),
		recover: () =>
			serial(async () => {
				for (const row of await writer.receivedAdminCommands()) {
					await run(row.payload as AdminCommand);
				}
			}),
	};
}
