// The gate (docs/ARCHITECTURE.md, section 4.4, requirements G2 to G10).
// Each action goes out one time at most. The gate writes "started" before the service call and "done" after it.
// The marks of the actions that run are in memory only. They go away if Petra stops.
import { testBot } from "@tensquads/bots";
import type { ActionAnswer, BotDefinition, Command } from "@tensquads/contracts";
import type { SendOutcome } from "@tensquads/core";

import { actionIdOf, contentHash } from "./hash.js";
import { type RuleCheck, ruleCheck } from "./rules.js";
import { contentProblem, describeAction, type Services, sendAction, serviceStatus } from "./services.js";
import type { ActionKind, ActionRequest, ActionRow, GateDeps } from "./types.js";

export type GateAnswer = ActionAnswer | { busy: true };

export interface Gate {
	// The gateway call "action". The answer "busy" means: the first call for this action still runs.
	action(request: ActionRequest): Promise<GateAnswer>;
	// The "check action" job (section 9). It takes only an action that is "started" for longer than the tool limit.
	checkJob(commandId: string, actionId: string): Promise<void>;
}

// The command id of a check has the attempt of the send and the number of the check.
const CHECK_ID = /^check-action\/(\d+)\/(\d+)\//;
export const checkActionCommandId = (actionId: string, attemptNo: number, checkNo: number): string =>
	`check-action/${attemptNo}/${checkNo}/${actionId}`;

const refused = (reason: string): ActionAnswer => ({ status: "refused", reason });

function kindOf(bots: readonly BotDefinition[], bot: string, tool: string): ActionKind | undefined {
	const found = bots.find((item) => item.id === bot)?.tools.find((item) => item.name === tool);
	return found?.kind === "action" ? found.actionKind : undefined;
}

const idOf = (row: ActionRow) => actionIdOf(row.taskId, row.toolCallId);
const keyOf = (row: ActionRow) => ({ taskId: row.taskId, toolCallId: row.toolCallId });

// The answer of an action with a final status.
function answerOf(row: ActionRow): ActionAnswer {
	switch (row.status) {
		case "done":
			return { status: "done", answer: row.answer };
		case "rejected":
			return refused(`The owner rejected the action ${idOf(row)}. It did not go out.`);
		case "not_confirmed":
			return refused(
				`The service cannot confirm the action ${idOf(row)}. The gate does not send it again. The owner is told.`,
			);
		case "refused":
			return refused(`A rule refused the action ${idOf(row)}.`);
		case "pending":
			return { status: "wait" };
		case "started":
			throw new Error(`The action ${idOf(row)} is still "started".`);
	}
}

export function gate(deps: GateDeps): Gate {
	const { store, tasks } = deps;
	const bots = deps.bots ?? [testBot];
	const services: Services = { payment: deps.payment, channel: deps.channel };
	const marks = new Set<string>();

	async function reread(row: ActionRow): Promise<ActionRow> {
		const stored = await store.action(row.taskId, row.toolCallId);
		if (!stored) throw new Error(`The action ${idOf(row)} is not in the database.`);
		return stored;
	}

	async function replyTo(taskId: string): Promise<string> {
		const task = await tasks.task(taskId);
		if (!task) throw new Error(`The task ${taskId} does not exist.`);
		return task.brief.replyTo;
	}

	async function queueCheck(actionId: string, attemptNo: number, checkNo: number): Promise<void> {
		const command: Command = {
			type: "RunJob",
			commandId: checkActionCommandId(actionId, attemptNo, checkNo),
			at: deps.now(),
			job: "check action",
			targetId: actionId,
		};
		const delaySeconds = Math.ceil(deps.toolLimitMs / 1000);
		await deps.queue.send("jobs", { accountId: deps.accountId, command }, { delaySeconds });
	}

	// The service cannot say if the action occurred. The gate does not repeat it, and Petra tells the owner.
	async function notConfirmed(row: ActionRow): Promise<ActionAnswer> {
		await store.moveAction({ ...keyOf(row), from: ["started"], to: "not_confirmed", at: deps.now() });
		const stored = await reread(row);
		if (stored.status === "not_confirmed") {
			await deps.tell({
				sourceRef: `action/${idOf(row)}/not_confirmed`,
				channel: await replyTo(row.taskId),
				taskId: row.taskId,
				body: {
					type: "action_not_confirmed",
					taskId: row.taskId,
					actionId: idOf(row),
					what: describeAction(row.tool, row.content),
				},
			});
		}
		return answerOf(stored);
	}

	// The status changes only if it is still "started".
	async function finish(row: ActionRow, outcome: SendOutcome): Promise<ActionAnswer> {
		if (outcome === "unknown") return notConfirmed(row);
		const answer = { outcome, actionId: idOf(row) };
		await store.moveAction({ ...keyOf(row), from: ["started"], to: "done", answer, at: deps.now() });
		return answerOf(await reread(row));
	}

	// The row is "started" before this call (requirement G6).
	async function send(row: ActionRow, attemptNo: number): Promise<ActionAnswer> {
		await queueCheck(idOf(row), attemptNo, 1);
		return finish(row, await sendAction(services, idOf(row), row.kind, row.content));
	}

	// An action that is "started" came again, and no call for it runs (requirement G9). The service decides.
	// "not_sent" means that the service never got the action, so the gate sends it now.
	async function askService(row: ActionRow, attemptNo: number): Promise<ActionAnswer> {
		const outcome = await serviceStatus(services, idOf(row), row.kind);
		return outcome === "not_sent" ? send(row, attemptNo) : finish(row, outcome);
	}

	// Each write has its key, so a pending action that comes again gives the owner one request (section 4.4).
	async function askOwner(row: ActionRow, terms: { ruleId: string | null; limit: number | null }) {
		const at = deps.now();
		await store.addApproval({ ...keyOf(row), contentHash: row.contentHash, ...terms, at });
		await deps.tell({
			sourceRef: `approval/${idOf(row)}/${row.contentHash}`,
			channel: await replyTo(row.taskId),
			taskId: row.taskId,
			body: {
				type: "approval_request",
				approvalId: idOf(row),
				action: row.tool,
				content: describeAction(row.tool, row.content),
				contentHash: row.contentHash,
				rule: terms.ruleId,
				limit: terms.limit,
			},
		});
		await tasks.setTaskStatus({ taskId: row.taskId, status: "waiting for the owner", at });
		return { status: "wait" } as const;
	}

	async function termsOf(row: ActionRow): Promise<{ ruleId: string | null; limit: number | null }> {
		const check = await ruleCheck(store, row.kind, row.content);
		return check.needs === "approval" ? { ruleId: check.ruleId, limit: check.limit } : { ruleId: null, limit: null };
	}

	// An approval belongs to one id and one hash (requirement G4).
	async function pendingAgain(row: ActionRow, attemptNo: number): Promise<ActionAnswer> {
		const approval = await store.approval(row.taskId, row.toolCallId, row.contentHash);
		if (approval?.status === "approved") {
			const moved = await store.moveAction({ ...keyOf(row), from: ["pending"], to: "started", at: deps.now() });
			const stored = await reread(row);
			return moved ? send(stored, attemptNo) : again(stored, attemptNo);
		}
		if (approval?.status === "rejected") {
			await store.moveAction({ ...keyOf(row), from: ["pending"], to: "rejected", at: deps.now() });
			return answerOf(await reread(row));
		}
		const terms = approval ? { ruleId: approval.ruleId, limit: approval.limit } : await termsOf(row);
		return askOwner(row, terms);
	}

	// The same id with the same hash is the same action.
	function again(row: ActionRow, attemptNo: number): Promise<ActionAnswer> {
		if (row.status === "started") return askService(row, attemptNo);
		if (row.status === "pending") return pendingAgain(row, attemptNo);
		return Promise.resolve(answerOf(row));
	}

	// The same id with a different hash is refused, with a trail row (requirement G8).
	async function refuseChanged(row: ActionRow, request: ActionRequest, hash: string): Promise<ActionAnswer> {
		await tasks.addTrail({
			sourceRef: `action/${idOf(row)}/changed/${hash}`,
			taskId: row.taskId,
			attemptNo: request.attemptNo,
			turnNo: null,
			kind: "refusal",
			actor: request.bot,
			summary: `The action ${idOf(row)} came again with a different content. The gate refused it.`,
			data: { toolCallId: row.toolCallId, tool: request.tool, contentHash: hash, savedHash: row.contentHash },
			at: deps.now(),
		});
		return refused(`The action ${idOf(row)} came again with a different content. The gate refused it.`);
	}

	async function fresh(request: ActionRequest, kind: ActionKind, hash: string): Promise<ActionAnswer> {
		const check: RuleCheck = await ruleCheck(store, kind, request.content);
		const status = check.needs === "nothing" ? "started" : "pending";
		const wrote = await store.addAction({
			taskId: request.taskId,
			toolCallId: request.toolCallId,
			attemptNo: request.attemptNo,
			tool: request.tool,
			kind,
			content: request.content,
			contentHash: hash,
			status,
			startedAt: status === "started" ? deps.now() : null,
		});
		const row = await store.action(request.taskId, request.toolCallId);
		if (!row) throw new Error(`The action ${actionIdOf(request.taskId, request.toolCallId)} was not written.`);
		if (!wrote) return row.contentHash === hash ? again(row, request.attemptNo) : refuseChanged(row, request, hash);
		if (check.needs === "nothing") return send(row, request.attemptNo);
		return askOwner(row, { ruleId: check.ruleId, limit: check.limit });
	}

	async function decide(request: ActionRequest, kind: ActionKind): Promise<ActionAnswer> {
		const hash = await contentHash(request.tool, request.content);
		const row = await store.action(request.taskId, request.toolCallId);
		if (!row) return fresh(request, kind, hash);
		return row.contentHash === hash ? again(row, request.attemptNo) : refuseChanged(row, request, hash);
	}

	// Runs the work with the mark of the action. A second call for the same action gets "busy".
	async function withMark<T>(actionId: string, busy: () => T | Promise<T>, work: () => Promise<T>): Promise<T> {
		if (marks.has(actionId)) return busy();
		marks.add(actionId);
		try {
			return await work();
		} finally {
			marks.delete(actionId);
		}
	}

	async function check(actionId: string, attemptNo: number, checkNo: number): Promise<void> {
		const row = await store.actionById(actionId);
		if (row?.status !== "started") return;
		const next = () => queueCheck(actionId, attemptNo, checkNo + 1);
		const age = Date.parse(deps.now()) - Date.parse(row.startedAt ?? deps.now());
		if (age < deps.toolLimitMs) return next();
		const outcome = await serviceStatus(services, idOf(row), row.kind);
		// The service never got the action. The next call of the action sends it.
		if (outcome !== "not_sent") await finish(row, outcome);
	}

	return {
		async action(request) {
			const kind = kindOf(bots, request.bot, request.tool);
			if (!kind) return refused(`The tool ${request.tool} is not an action tool of the bot ${request.bot}.`);
			const problem = contentProblem(kind, request.content);
			if (problem) return refused(problem);
			const actionId = actionIdOf(request.taskId, request.toolCallId);
			return withMark<GateAnswer>(
				actionId,
				() => ({ busy: true }),
				() => decide(request, kind),
			);
		},

		async checkJob(commandId, actionId) {
			const match = CHECK_ID.exec(commandId);
			if (!match) return;
			const [attemptNo, checkNo] = [Number(match[1]), Number(match[2])];
			// A call for the action still runs. The check comes again later.
			await withMark(
				actionId,
				() => queueCheck(actionId, attemptNo, checkNo + 1),
				() => check(actionId, attemptNo, checkNo),
			);
		},
	};
}
