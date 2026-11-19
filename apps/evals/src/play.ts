// Plays one run of one case through the full path (docs/ARCHITECTURE.md, section 4.8, requirement E2).
// Each run has a new test account, made from the setup of the case. The Worker is in the mode with no outgoing
// action: the channel and the payment only record what they would send.
import { evalOwnerRef, evalOwnerToken } from "@tensquads/adapters-test";
import type { CaseSetup, EvalCase, EvalStep } from "@tensquads/contracts";
import type { RunRecord } from "@tensquads/evals";

import { claimsOf, LocalPath, SUPER_ADMIN, waitFor } from "./full-path.js";
import { EVAL_PRICES, PRICES_FROM } from "./prices.js";
import { readRecord } from "./record.js";

// The settings of each eval Worker.
const EVAL_VARS = { NO_OUTGOING_ACTION: "yes", EVAL_OWNERS: "yes" } as const;

// A task that does not start or run. A task that waits for the owner is still: its attempt parked, and (b) below
// waits for the report of its exit. A case can end with a task that waits, as K3 with a script that asks too much.
const STILL = "'done', 'failed', 'cancelled', 'waiting for the owner'";

// The time limit of one run, and of the wait for one step.
const RUN_MS = 120_000;

// The settings of the Worker that the setup of a case needs: the outcomes of the services and the fixed decider.
export function setupVars(setup: CaseSetup): Record<string, string> {
	return {
		CHANNEL_OUTCOME: setup.services.channel,
		PAYMENT_OUTCOME: setup.services.payment,
		FIXED_DECIDER_POINTS: JSON.stringify(setup.decider),
	};
}

export interface PlayedRun {
	accountId: string;
	record: RunRecord;
	ms: number;
}

const now = () => new Date().toISOString();

// The hold of the gateway calls of an account after its first tool call, for the condition
// "after the first tool call". The held call waits until the step is done.
class ToolCallHold {
	private seen = false;
	private held = false;
	private release: () => void = () => {};
	private readonly gate = new Promise<void>((resolve) => {
		this.release = resolve;
	});
	// The number of gateway calls when the hold ended. Each later model request came after the step.
	releasedAt: number | undefined;

	rule(call: { call: string }): Promise<void> | undefined {
		if (this.releasedAt !== undefined) return undefined;
		if (call.call === "step") {
			this.seen = true;
			return undefined;
		}
		if (!this.seen) return undefined;
		this.held = true;
		return this.gate;
	}

	isHolding = () => (this.held ? true : undefined);

	end(calls: number): void {
		this.releasedAt ??= calls;
		this.release();
	}
}

export class EvalWorker {
	readonly path: LocalPath;

	constructor(vars: Readonly<Record<string, string>>) {
		this.path = new LocalPath({ vars: { ...vars, ...EVAL_VARS } });
	}

	async start(): Promise<void> {
		await this.path.start();
		// The prices of the test adapters, so the cost view has a cost (decision D26).
		for (const price of EVAL_PRICES) {
			await this.path.admin({
				type: "SetUnitPrice",
				commandId: `eval-price/${price.provider}/${price.model}/${price.unit}`,
				at: now(),
				startsAt: PRICES_FROM,
				...price,
			});
		}
	}

	stop(): Promise<void> {
		return this.path.stop();
	}

	// A GET call of the admin API, as the super admin.
	adminGet = (path: string): Promise<Response> => this.path.api(path, SUPER_ADMIN);

	// Sends one command as the owner of the account.
	async command(accountId: string, command: Record<string, unknown>): Promise<void> {
		const answer = await this.path.api("/v1/commands", evalOwnerToken(accountId), { at: now(), ...command });
		if (!answer.ok) throw new Error(`The command ${String(command.type)} failed: ${await answer.text()}`);
	}

	// True when the account is still, so no cost row can come later. The four conditions: (a) no task starts or
	// runs; (b) the launcher reported the exit of each attempt (the event "exit/..."); (c) each event of the account
	// is done; (d) the turn of Petra for each owner message ended. Petra marks the command done in her tool, before
	// her last model call, so (c) alone misses the cost rows of that call.
	async isStill(accountId: string): Promise<true | undefined> {
		const [row] = await this.path.query<{ busy: string; unreported: string; open: string }>(
			`SELECT (SELECT count(*) FROM tasks WHERE account_id = $1 AND status NOT IN (${STILL})) AS busy,
			 (SELECT count(*) FROM attempts a JOIN tasks t ON t.id = a.task_id WHERE t.account_id = $1
			  AND NOT EXISTS (SELECT 1 FROM events e WHERE e.account_id = $1
			   AND e.command_id = 'exit/' || a.task_id || '/' || a.attempt_no)) AS unreported,
			 (SELECT count(*) FROM events WHERE account_id = $1 AND status <> 'done') AS open`,
			[accountId],
		);
		if ([row?.busy, row?.unreported, row?.open].some((n) => Number(n) !== 0)) return undefined;
		return (await this.turnsEnded(accountId)) ? true : undefined;
	}

	// The Worker logs "petra: turn ended {commandId}" after the cost rows of the last model call of a turn.
	private async turnsEnded(accountId: string): Promise<boolean> {
		const commands = await this.path.query<{ command_id: string }>(
			"SELECT command_id FROM events WHERE account_id = $1 AND kind = 'OwnerMessage'",
			[accountId],
		);
		const ended = new Set([...this.path.workerLog.matchAll(/petra: turn ended (\S+)/g)].map((match) => match[1]));
		return commands.every((command) => ended.has(command.command_id));
	}

	private waitStill(accountId: string, what: string): Promise<true> {
		return waitFor(`${what} of ${accountId}`, () => this.isStill(accountId), RUN_MS);
	}

	// The new test account, its owner, its rules and its memory. Returns the facts of the memory with their ids.
	async setUp(accountId: string, setup: CaseSetup): Promise<{ id: string; text: string }[]> {
		await this.path.admin({
			type: "CreateAccount",
			commandId: accountId,
			at: now(),
			name: `Eval ${accountId}`,
			timeZone: "Asia/Riyadh",
			language: "en",
			modelProfile: "test",
			initialCredits: setup.credits,
		});
		const identityRef = evalOwnerRef(accountId);
		await this.path.admin({ type: "AddOwner", commandId: `${accountId}/owner`, at: now(), accountId, identityRef });
		for (const [index, rule] of setup.rules.entries()) {
			await this.command(accountId, { type: "SetRule", commandId: `${accountId}-rule-${index}`, rule });
		}
		const facts = setup.memory.map((fact, index) => {
			const commandId = `${accountId}-fact-${index}`;
			return { commandId, id: `cmd/${commandId}/fact`, text: fact.text, page: fact.page };
		});
		for (const fact of facts) {
			const text = `remember on ${fact.page}: ${fact.text}`;
			await this.ownerMessage(accountId, fact.commandId, text);
		}
		await this.waitStill(accountId, "the setup");
		return facts.map(({ id, text }) => ({ id, text }));
	}

	private ownerMessage(accountId: string, commandId: string, text: string): Promise<void> {
		return this.command(accountId, {
			type: "OwnerMessage",
			commandId,
			messageId: `m-${commandId}`,
			channel: "chat",
			text,
		});
	}

	// The body of the newest message to the owner of one type.
	private async newest(accountId: string, type: string): Promise<Record<string, string>> {
		const [row] = await this.path.query<{ body: Record<string, string> }>(
			"SELECT body FROM messages WHERE account_id = $1 AND type = $2 ORDER BY seq DESC LIMIT 1",
			[accountId, type],
		);
		if (!row) throw new Error(`The account ${accountId} has no message of the type ${type}.`);
		return row.body;
	}

	// The command of one step. The command id starts with the account id, so each task id is new.
	private async stepCommand(
		accountId: string,
		step: EvalStep,
		commandId: string,
		facts: readonly { id: string }[],
	): Promise<Record<string, unknown>> {
		switch (step.type) {
			case "OwnerMessage":
				return { type: step.type, commandId, messageId: `m-${commandId}`, channel: "chat", text: step.text };
			case "ForgetFact":
				return { type: step.type, commandId, factId: facts[step.fact]?.id };
			case "ApprovalDecision": {
				const request = await this.newest(accountId, "approval_request");
				const { approvalId, contentHash } = request;
				return { type: step.type, commandId, approvalId, contentHash, decision: step.decision };
			}
			case "OwnerAnswer":
				return {
					type: step.type,
					commandId,
					questionId: (await this.newest(accountId, "question")).questionId,
					text: step.text,
				};
		}
	}

	// Waits for the condition of the step. A step with no condition is the first step.
	private async waitFor(accountId: string, step: EvalStep, hold: ToolCallHold): Promise<void> {
		if (step.when === "after the first tool call") {
			await waitFor(`the first tool call of ${accountId}`, async () => hold.isHolding(), RUN_MS);
		} else if (step.when === "when the task waits") {
			await waitFor(
				`a task of ${accountId} waits`,
				async () => {
					const rows = await this.path.query(
						"SELECT 1 FROM tasks WHERE account_id = $1 AND status = 'waiting for the owner'",
						[accountId],
					);
					return rows.length > 0 ? true : undefined;
				},
				RUN_MS,
			);
		} else if (step.when === "after the last step") {
			await this.waitStill(accountId, "the last step");
		}
	}

	// Plays the steps of the case, then waits until the account is still, and reads the record of the run.
	async play(evalCase: EvalCase, accountId: string): Promise<PlayedRun> {
		const facts = await this.setUp(accountId, evalCase.setup);
		const setupSeq = await this.maxSeq(accountId);
		const hold = new ToolCallHold();
		// The hold is armed only for a case with a step "after the first tool call".
		const holds = evalCase.input.some((step) => step.when === "after the first tool call");
		this.path.rule = (call) => (holds && claimsOf(call.pass).accountId === accountId ? hold.rule(call) : undefined);
		const started = Date.now();
		try {
			for (const [index, step] of evalCase.input.entries()) {
				await this.waitFor(accountId, step, hold);
				await this.command(accountId, await this.stepCommand(accountId, step, `${accountId}-step-${index}`, facts));
				if (step.when === "after the first tool call") {
					await waitFor(
						`the step ${index} of ${accountId}`,
						async () => this.eventDone(accountId, `${accountId}-step-${index}`),
						RUN_MS,
					);
					hold.end(this.path.calls.length);
				}
			}
			await this.waitStill(accountId, "the end of the run");
		} finally {
			hold.end(this.path.calls.length);
			this.path.rule = () => undefined;
		}
		const ms = Date.now() - started;
		const record = await readRecord(this.path, { accountId, setupSeq, facts, releasedAt: hold.releasedAt ?? 0 });
		return { accountId, record, ms };
	}

	private async eventDone(accountId: string, commandId: string): Promise<true | undefined> {
		const rows = await this.path.query(
			"SELECT 1 FROM events WHERE account_id = $1 AND command_id = $2 AND status = 'done'",
			[accountId, commandId],
		);
		return rows.length > 0 ? true : undefined;
	}

	private async maxSeq(accountId: string): Promise<number> {
		const [row] = await this.path.query<{ seq: string | null }>(
			"SELECT max(seq) AS seq FROM messages WHERE account_id = $1",
			[accountId],
		);
		return Number(row?.seq ?? 0);
	}

	// The cost of the account from the cost view of the account, in millionths of a US dollar.
	async cost(accountId: string): Promise<number> {
		const response = await this.adminGet("/v1/admin/views/account");
		if (!response.ok) throw new Error(`The cost view failed with the status ${response.status}.`);
		const { rows } = (await response.json()) as { rows: { account_id: string; cost: string | number }[] };
		return Number(rows.find((row) => row.account_id === accountId)?.cost ?? 0);
	}
}
