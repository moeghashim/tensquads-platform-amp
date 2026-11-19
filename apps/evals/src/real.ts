// The command `npm run evals -- --real` (task 12, requirement N8). It plays the cases of evals/cases/real against a
// staging Worker, with the real model of Petra. It does not run in CI. It uses only the HTTP interface of the Worker,
// so the record of a run has the messages, the tasks, the credits and the cost, and no row of the database.
// It starts the launcher on this machine, so a task of the test bot can run.
// Settings: STAGING_URL, STAGING_ADMIN_TOKEN (a super admin of IDENTITY_TOKENS), LAUNCHER_KEY. The staging Worker
// must have EVAL_OWNERS=yes during the run, so the owner of each new eval account can send commands.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { evalOwnerRef, evalOwnerToken, ruleChecker } from "@tensquads/adapters-test";
import { type EvalCase, type EvalStep, evalCase } from "@tensquads/contracts";
import { ports, startSystem } from "@tensquads/core";
import { formatReport, gradeRun, type RunRecord, type RunResult, versionReport } from "@tensquads/evals";

import { EVALS_DIR } from "./files.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
// A run ends when no task runs and no new message came in this time. A real model can answer the owner first and
// start the task more than 20 seconds later, so the time is long.
const QUIET_MS = 60_000;
const RUN_MS = 600_000;
const POLL_MS = 1000;
const STILL = new Set(["done", "failed", "cancelled", "waiting for the owner"]);
// A fetch that fails (for example, the other side closed the socket) gets three more tries.
const MORE_TRIES = 3;
const RETRY_WAIT_MS = 2000;

export interface RealOptions {
	url: string;
	adminToken: string;
	launcherKey: string;
	runs: number;
	log: (line: string) => void;
	// The fetch function. The default is the global fetch. A test gives a fake.
	fetch?: typeof fetch;
	// The wait before the next try of a failed fetch. The default is RETRY_WAIT_MS.
	retryWaitMs?: number;
}

// The cases of the real model. They are in a folder of their own, so `npm run evals` with the fake model skips them.
export function loadRealCases(): EvalCase[] {
	const dir = join(EVALS_DIR, "cases", "real");
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => evalCase.parse(JSON.parse(readFileSync(join(dir, name), "utf8"))))
		.sort((a, b) => a.id.localeCompare(b.id));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

// A request with no body is a GET. A request with a body is a POST of JSON.
function requestInit(token: string, body?: unknown): RequestInit & { method: string } {
	return {
		method: body === undefined ? "GET" : "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	};
}

export class Staging {
	constructor(private readonly options: RealOptions) {}

	// Each try sends the same request. A command has the same body and command id in each try, and the Worker
	// accepts a command one time for one command id (section 9).
	async call(path: string, token: string, body?: unknown): Promise<Response> {
		const init = requestInit(token, body);
		for (let tryNo = 1; ; tryNo += 1) {
			try {
				return await this.tryOnce(path, init, tryNo <= MORE_TRIES);
			} catch (error) {
				if (tryNo > MORE_TRIES) throw error;
				this.options.log(`real: ${init.method} ${path} failed (${String(error)}). Try ${tryNo + 1}.`);
				await sleep(this.options.retryWaitMs ?? RETRY_WAIT_MS);
			}
		}
	}

	// One try. A server error is a failure of this try, as a closed socket is, while more tries are left.
	private async tryOnce(path: string, init: RequestInit, moreTries: boolean): Promise<Response> {
		const answer = await (this.options.fetch ?? fetch)(`${this.options.url}${path}`, init);
		if (answer.status >= 500 && moreTries) throw new Error(`status ${answer.status}`);
		return answer;
	}

	async send(path: string, token: string, body: Record<string, unknown>): Promise<void> {
		const answer = await this.call(path, token, { at: now(), ...body });
		if (!answer.ok) throw new Error(`The command ${String(body.type)} failed with the status ${answer.status}.`);
	}

	admin = (body: Record<string, unknown>) => this.send("/v1/admin/commands", this.options.adminToken, body);
	owner = (accountId: string, body: Record<string, unknown>) =>
		this.send("/v1/commands", evalOwnerToken(accountId, this.options.adminToken), body);

	async messages(accountId: string, after = 0): Promise<RunRecord["messages"]> {
		const answer = await this.call(`/v1/messages?after=${after}`, evalOwnerToken(accountId, this.options.adminToken));
		const { messages } = (await answer.json()) as { messages: (Record<string, unknown> & { type: string })[] };
		return messages.map(({ type, ...body }) => ({ type, body }));
	}

	async lastSeq(accountId: string): Promise<number> {
		const answer = await this.call("/v1/messages?after=0", evalOwnerToken(accountId, this.options.adminToken));
		const { messages } = (await answer.json()) as { messages: { seq: number }[] };
		return messages.at(-1)?.seq ?? 0;
	}

	// One command starts one task or none, and the task id is the command id (section 4.6).
	async tasks(accountId: string, commandIds: readonly string[]): Promise<RunRecord["tasks"]> {
		const found: { id: string; status: string }[] = [];
		for (const id of commandIds) {
			const answer = await this.call(
				`/v1/tasks/${encodeURIComponent(id)}`,
				evalOwnerToken(accountId, this.options.adminToken),
			);
			if (answer.ok) found.push({ id, status: ((await answer.json()) as { status: string }).status });
			// A 404 means that the command started no task. Any other error is not an answer: the run stops with it,
			// so a lost answer never looks like "no task".
			else if (answer.status !== 404) throw new Error(`The status of the task ${id} failed with ${answer.status}.`);
		}
		return found;
	}

	async accountRow(accountId: string): Promise<{ cost: number; creditsUsed: number }> {
		const answer = await this.call("/v1/admin/views/account", this.options.adminToken);
		const { rows } = (await answer.json()) as { rows: Record<string, string | number>[] };
		const row = rows.find((item) => item.account_id === accountId);
		return { cost: Number(row?.cost ?? 0), creditsUsed: Number(row?.credits_used ?? 0) };
	}
}

function startLauncher(options: RealOptions): ChildProcess {
	spawnSync("npm", ["run", "build", "-w", "@tensquads/launcher"], { cwd: ROOT, stdio: "ignore" });
	return spawn("node", ["dist/main.js"], {
		cwd: join(ROOT, "apps", "launcher"),
		env: { PATH: process.env.PATH ?? "", WORKER_URL: options.url, LAUNCHER_KEY: options.launcherKey },
		stdio: "ignore",
	});
}

// The command of one step. A decision or an answer is for the newest approval request or question.
async function stepBody(s: Staging, accountId: string, step: EvalStep, commandId: string) {
	const newest = async (type: string) => (await s.messages(accountId)).filter((m) => m.type === type).at(-1)?.body;
	if (step.type === "OwnerMessage")
		return { type: step.type, commandId, messageId: commandId, channel: "chat", text: step.text };
	if (step.type === "ApprovalDecision") {
		const request = await newest("approval_request");
		return {
			type: step.type,
			commandId,
			approvalId: request?.approvalId,
			contentHash: request?.contentHash,
			decision: step.decision,
		};
	}
	if (step.type === "OwnerAnswer")
		return { type: step.type, commandId, questionId: (await newest("question"))?.questionId, text: step.text };
	throw new Error(`The real evals do not play the step ${step.type}.`);
}

// Waits until no task of the run runs and no new message came for QUIET_MS.
async function waitStill(s: Staging, accountId: string, commandIds: readonly string[]): Promise<void> {
	const deadline = Date.now() + RUN_MS;
	let seq = -1;
	let quietSince = Date.now();
	while (Date.now() < deadline) {
		const current = await s.lastSeq(accountId);
		if (current !== seq) [seq, quietSince] = [current, Date.now()];
		const tasks = await s.tasks(accountId, commandIds);
		if (tasks.every((task) => STILL.has(task.status)) && Date.now() - quietSince >= QUIET_MS) return;
		await sleep(POLL_MS);
	}
	throw new Error(`The run of ${accountId} did not end in ${RUN_MS} ms.`);
}

async function playReal(s: Staging, item: EvalCase, accountId: string): Promise<RunResult & { accountId: string }> {
	await s.admin({
		type: "CreateAccount",
		commandId: accountId,
		name: accountId,
		timeZone: "Asia/Riyadh",
		language: "en",
		modelProfile: "real",
		initialCredits: item.setup.credits,
	});
	await s.admin({
		type: "AddOwner",
		commandId: `${accountId}/owner`,
		accountId,
		identityRef: evalOwnerRef(accountId),
	});
	for (const [index, rule] of item.setup.rules.entries())
		await s.owner(accountId, { type: "SetRule", commandId: `${accountId}-rule-${index}`, rule });
	const commandIds: string[] = [];
	for (const [index, fact] of item.setup.memory.entries()) {
		const commandId = `${accountId}-fact-${index}`;
		await s.owner(accountId, {
			type: "OwnerMessage",
			commandId,
			messageId: commandId,
			channel: "chat",
			text: `remember on ${fact.page}: ${fact.text}`,
		});
		commandIds.push(commandId);
	}
	await waitStill(s, accountId, commandIds);
	const setupSeq = await s.lastSeq(accountId);
	const started = Date.now();
	for (const [index, step] of item.input.entries()) {
		const commandId = `${accountId}-step-${index}`;
		if (index > 0) await waitStill(s, accountId, commandIds);
		await s.owner(accountId, await stepBody(s, accountId, step, commandId));
		commandIds.push(commandId);
	}
	await waitStill(s, accountId, commandIds);
	const ms = Date.now() - started;
	const { cost, creditsUsed } = await s.accountRow(accountId);
	const record: RunRecord = {
		tasks: await s.tasks(accountId, commandIds.slice(item.setup.memory.length)),
		messages: await s.messages(accountId, setupSeq),
		creditsTaken: creditsUsed,
		actions: [],
		trail: [],
		sends: [],
		forgetList: [],
		facts: [],
		modelRequests: [],
	};
	const checker = (await startSystem([ruleChecker()])).port(ports.checkerModel);
	const grade = await gradeRun(item, accountId, record, { checker, review: async () => undefined });
	return { caseId: item.id, runNo: 0, ...grade, cost, ms, accountId };
}

type PlayRun = (item: EvalCase, accountId: string) => Promise<RunResult & { accountId: string }>;

// Plays each run of each case. A run that stops with an error is a "fail" with the reason. The next run continues.
export async function playAll(
	options: RealOptions,
	cases: readonly EvalCase[],
	stamp: string,
	play: PlayRun,
): Promise<RunResult[]> {
	const results: RunResult[] = [];
	// The runs of one case play at the same time. Each run has its own account, so the runs do not meet.
	const one = async (item: EvalCase, runNo: number): Promise<RunResult> => {
		const accountId = `eval-${stamp}-real-${item.id}-${runNo}`.toLowerCase();
		let result: RunResult;
		try {
			result = { ...(await play(item, accountId)), runNo };
		} catch (error) {
			const reason = `The run stopped: ${error instanceof Error ? error.message : String(error)}`;
			result = { caseId: item.id, runNo, verdict: "fail", reasons: [reason], cost: 0, ms: 0 };
		}
		options.log(`real ${item.id} run ${runNo}: ${result.verdict} (${accountId}) ${result.reasons.join(" ")}`);
		return result;
	};
	for (const item of cases) {
		const runNos = Array.from({ length: options.runs }, (_, index) => index + 1);
		results.push(...(await Promise.all(runNos.map((runNo) => one(item, runNo)))));
	}
	return results;
}

export async function runRealEvals(options: RealOptions, cases: readonly EvalCase[]): Promise<void> {
	const s = new Staging(options);
	const launcher = startLauncher(options);
	let results: RunResult[];
	try {
		results = await playAll(options, cases, Date.now().toString(36), (item, accountId) =>
			playReal(s, item, accountId),
		);
	} finally {
		launcher.kill("SIGTERM");
	}
	options.log(formatReport(versionReport("real", results)));
	// The cost view of each model, with the mean cost of one owner command (requirement N8).
	const view = await s.call("/v1/admin/views/model", options.adminToken);
	const { rows } = (await view.json()) as { rows: Record<string, unknown>[] };
	for (const row of rows) {
		options.log(
			`model ${row.provider}/${row.model}: calls ${row.calls}, cost ${row.cost}, owner commands ${row.owner_commands}, mean ${row.mean_command_cost}`,
		);
	}
}
