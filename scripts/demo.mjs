#!/usr/bin/env node

// The fixed demo of PRD section 9 against staging (task 13). Petra and the Platform object run on Cloudflare.
// The launcher and the runner run on this machine. A small proxy sits between them and the Worker. It holds the
// second turn of attempt 1 until the message of the owner is in the inbox of the task, so each run is the same.
//
//   node scripts/demo.mjs fixed   one run: items 1 to 4 of the demo
//   node scripts/demo.mjs kill    one run that kills the runner after the gate did the refund (item 5)
//   node scripts/demo.mjs twice   two runs on two new accounts, and a comparison of the two outputs (item 6)
//
// Settings: STAGING_URL, STAGING_ADMIN_TOKEN (a super admin of IDENTITY_TOKENS), LAUNCHER_KEY, and DATABASE_URL (a
// connection to the staging database that reads the decision records and the cost rows; the demo never writes).
// The Worker must have EVAL_OWNERS=yes during the demo, so the owner of each new demo account can send commands.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";

import { PRICES } from "./demo-client.mjs";

const ROOT = join(import.meta.dirname, "..");
const GOAL = "Please read 3 files then refund 60 to cust-1";
const STEER = "Please put a thank-you note in the box.";
const LIMIT_MICROS = 20_000_000;
// These values come from the time that a sandbox ran, so they differ between two runs.
const TIMED = new Set(["sandbox", "cost", "difference"]);

function setting(name) {
	const value = process.env[name];
	if (!value) throw new Error(`The setting ${name} is missing.`);
	return value;
}

const url = setting("STAGING_URL");
const adminToken = setting("STAGING_ADMIN_TOKEN");
const launcherKey = setting("LAUNCHER_KEY");
const db = new pg.Client({ connectionString: setting("DATABASE_URL") });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ownerToken = (accountId) => `${adminToken} eval-owner:${accountId}`;

// A fetch that fails (the other side closed the socket) gets three more tries with the same request. A command has
// the same command id in each try, and the Worker accepts it one time.
async function send(target, init, tryNo = 1) {
	try {
		return await fetch(target, init);
	} catch (error) {
		if (tryNo > 3) throw error;
		await sleep(2000);
		return send(target, init, tryNo + 1);
	}
}

// A call with no body is a GET. A command gets the time now.
function requestInit(token, body) {
	const init = { method: "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
	if (body === undefined) return init;
	return { ...init, method: "POST", body: JSON.stringify({ at: new Date().toISOString(), ...body }) };
}

// A 404 is an answer (for example, no task yet). Each other error stops the demo.
async function api(path, token, body) {
	const response = await send(`${url}${path}`, requestInit(token, body));
	const text = await response.text();
	if (!response.ok && response.status !== 404) throw new Error(`${path} gave ${response.status}: ${text}`);
	return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

const admin = (body) => api("/v1/admin/commands", adminToken, body);
const owner = (accountId, body) => api("/v1/commands", ownerToken(accountId), body);

async function waitFor(what, check, end = Date.now() + 300_000) {
	const value = await check();
	if (value !== undefined) return value;
	if (Date.now() > end) throw new Error(`Timed out: ${what}`);
	await sleep(500);
	return waitFor(what, check, end);
}

// The claims of a pass. The proxy does not check the signature; the Worker does.
const claimsOf = (pass) => JSON.parse(Buffer.from(pass.split(".")[0] ?? "", "base64url").toString());

async function readBody(request) {
	let body = "";
	for await (const chunk of request) body += chunk;
	return body;
}

const passOf = (request) => request.headers.authorization?.replace(/^Bearer /, "") ?? "";
const gatewayCallOf = (request, body) => (request.url === "/v1/gateway" ? JSON.parse(body) : undefined);

// One call to the Worker, with the same method, pass and body. Undefined when the fetch fails.
async function forward(request, body) {
	const init = {
		method: request.method,
		headers: { authorization: request.headers.authorization ?? "" },
	};
	if (body !== "") init.body = body;
	try {
		const answer = await fetch(`${url}${request.url}`, init);
		return { status: answer.status, text: await answer.text() };
	} catch {
		return undefined;
	}
}

// True for an inbox call of this task and attempt.
function isInboxOf(call, pass, taskId, attemptNo) {
	const claims = claimsOf(pass);
	return call.call === "inbox" && claims.taskId === taskId && claims.attemptNo === attemptNo;
}

// The proxy between the launcher and the Worker. A rule can hold a gateway call, or kill the runner after an answer.
class RunnerProxy {
	holds = [];
	killAfter = () => false;
	killed = [];
	inboxCalls = new Map();
	pids = join(mkdtempSync(join(tmpdir(), "tensquads-demo-")), "runners");

	async start() {
		writeFileSync(this.pids, "");
		this.server = createServer((request, response) => void this.relay(request, response));
		await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
		this.url = `http://127.0.0.1:${this.server.address().port}`;
	}

	async relay(request, response) {
		const body = await readBody(request);
		const pass = passOf(request);
		const call = gatewayCallOf(request, body);
		await this.runHolds(call, pass);
		const answer = await forward(request, body);
		// The runner and the launcher try a failed call again, as they do with no proxy.
		if (!answer) return response.writeHead(502).end();
		if (this.mustKill(call, pass, answer)) return this.kill(pass, response);
		response.writeHead(answer.status, { "content-type": "application/json" }).end(answer.text);
	}

	async runHolds(call, pass) {
		for (const hold of call ? this.holds : []) await hold(call, pass);
	}

	mustKill(call, pass, answer) {
		return call !== undefined && this.killAfter(call, pass, answer.text);
	}

	// The second inbox call of an attempt waits until the gate opens: the turn after it gets the message.
	// A retry has the same call number, so the proxy counts call numbers, not requests.
	holdSecondInbox(taskId, attemptNo, gate) {
		this.holds.push(async (call, pass) => {
			if (!isInboxOf(call, pass, taskId, attemptNo)) return;
			const seen = this.inboxCalls.get(pass) ?? new Set();
			this.inboxCalls.set(pass, seen.add(call.callNo));
			if ([...seen].sort((a, b) => a - b)[1] === call.callNo) await gate();
		});
	}

	// Each runner wrote "<process id> <pass>" when it started. The runner of the pass gets SIGKILL, as a sandbox
	// that stops, and its call gets no answer.
	kill(pass, response) {
		const runners = readFileSync(this.pids, "utf8").split("\n");
		const pid = Number(runners.findLast((line) => line.endsWith(` ${pass}`))?.split(" ")[0]);
		this.killed.push(claimsOf(pass).attemptNo);
		process.kill(pid, "SIGKILL");
		response.destroy();
	}

	reset() {
		this.holds = [];
		this.killAfter = () => false;
	}
}

function startLauncher(proxy) {
	spawnSync("npm", ["run", "build", "-w", "@tensquads/launcher"], { cwd: ROOT, stdio: "ignore" });
	const runner = join(ROOT, "apps", "runner", "src", "main.ts");
	const command = `echo "$$ $PASS" >> ${proxy.pids} && exec node --import ${import.meta.resolve("tsx")} ${runner}`;
	return spawn("node", ["dist/main.js"], {
		cwd: join(ROOT, "apps", "launcher"),
		env: { PATH: process.env.PATH ?? "", WORKER_URL: proxy.url, LAUNCHER_KEY: launcherKey, RUNNER_COMMAND: command },
		stdio: "ignore",
	});
}

const messagesOf = async (accountId) => (await api("/v1/messages?after=0", ownerToken(accountId))).body.messages;

const waitForMessage = (accountId, type, check = () => true) =>
	waitFor(`a message ${type}`, async () =>
		(await messagesOf(accountId)).find((message) => message.type === type && check(message)),
	);

const waitForStatus = (accountId, taskId, status) =>
	waitFor(`task ${taskId} is ${status}`, async () => {
		const task = (await api(`/v1/tasks/${taskId}`, ownerToken(accountId))).body;
		return task?.status === status ? task : undefined;
	});

// A new account with the "test" profile, its owner, and a refund limit of $20.
async function setUpAccount(accountId, say) {
	const base = { name: "Demo cafe", timeZone: "Asia/Riyadh", language: "en", modelProfile: "test" };
	await admin({ type: "CreateAccount", commandId: accountId, ...base, initialCredits: 100 });
	await admin({ type: "AddOwner", commandId: `${accountId}/owner`, accountId, identityRef: `owner-${accountId}` });
	say(`== Account ${accountId} (profile "test", 100 credits). The owner sets a refund limit of $20.`);
	const rule = { kind: "money_limit", params: { maxAmount: LIMIT_MICROS } };
	await owner(accountId, { type: "SetRule", commandId: `${accountId}-rule`, rule });
}

const ownerMessage = (commandId, text) => ({
	type: "OwnerMessage",
	commandId,
	messageId: commandId,
	channel: "chat",
	text,
});

// The owner sends the second message while turn 2 of attempt 1 waits. Then the turn continues.
function steerDuringTurn2(proxy, accountId, taskId, say) {
	let steered;
	const steer = async () => {
		say(`== During the task, the owner sends: "${STEER}"`);
		await owner(accountId, ownerMessage(`${accountId}-steer`, STEER));
		const reply = await waitForMessage(accountId, "reply", (m) => m.text.startsWith("I gave your message"));
		say(`   Petra: ${reply.text}`);
	};
	proxy.holdSecondInbox(taskId, 1, () => {
		steered ??= steer();
		return steered;
	});
}

// Kill the runner one time, after the gate did the refund and before the runner gets the answer.
// The next attempt asks for the same action again, and the gate gives the stored answer.
function killAfterRefund(proxy, taskId) {
	proxy.killAfter = (call, pass, answer) =>
		call.call === "action" &&
		answer.includes('"status":"done"') &&
		claimsOf(pass).taskId === taskId &&
		proxy.killed.length === 0;
}

async function askAndApprove(accountId, taskId, say) {
	say(`== The owner sends: "${GOAL}"`);
	await owner(accountId, ownerMessage(taskId, GOAL));
	const approval = await waitForMessage(accountId, "approval_request");
	say(`== Petra asks for an approval: ${approval.action}, amount ${approval.amount}, limit ${approval.limit}`);
	await waitForStatus(accountId, taskId, "waiting for the owner");
	say(`   The task is "waiting for the owner". Its sandbox stopped.`);
	const { approvalId, contentHash } = approval;
	await owner(accountId, {
		type: "ApprovalDecision",
		commandId: `${accountId}-approve`,
		approvalId,
		decision: "approve",
		contentHash,
	});
	say("== The owner approves the exact content (its hash)");
}

// One run of the fixed demo on a new account with the "test" profile. Returns the lines of its output.
async function runDemo(proxy, accountId, kill) {
	const taskId = `${accountId}-task`;
	const lines = [];
	const say = (line) => {
		lines.push(line);
		console.log(line);
	};
	await setUpAccount(accountId, say);
	steerDuringTurn2(proxy, accountId, taskId, say);
	if (kill) killAfterRefund(proxy, taskId);
	await askAndApprove(accountId, taskId, say);
	const done = await waitForStatus(accountId, taskId, "done");
	for (const attemptNo of proxy.killed) say(`== The proxy killed the runner of attempt ${attemptNo} after the refund`);
	say(`== The task is done after attempt ${done.activity?.attemptNo}`);
	say(`== The result:\n${(await waitForMessage(accountId, "result")).summary}`);
	await printRecords(say, accountId, taskId);
	proxy.reset();
	return { accountId, lines };
}

async function rows(sql, accountId, taskId) {
	return (await db.query(sql, taskId === undefined ? [accountId] : [accountId, taskId])).rows;
}

// One section of the output: a title and one line for each row.
async function section(say, title, rowsOf, line) {
	say(`\n== ${title}`);
	for (const row of await rowsOf()) say(`   ${line(row)}`);
}

const LEDGER = "SELECT kind, credits FROM ledger WHERE account_id = $1 ORDER BY at";
const DECISIONS = "SELECT point, decider, answer, used FROM decisions WHERE account_id = $1 ORDER BY at, decider";
const ACTIONS = "SELECT tool, status FROM actions WHERE account_id = $1 ORDER BY tool_call_id";

async function printRecords(say, accountId, taskId) {
	const messages = () => messagesOf(accountId);
	await section(say, "The messages to the owner", messages, (m) => [m.type, m.text].filter(Boolean).join(": "));
	await printTrail(say, accountId, taskId);
	await section(
		say,
		"The credits of the account",
		() => rows(LEDGER, accountId),
		(row) => {
			return `${row.kind.padEnd(10)} ${row.credits}`;
		},
	);
	await section(
		say,
		"The decision records",
		() => rows(DECISIONS, accountId),
		(row) => {
			return `${row.point.padEnd(18)} ${row.decider.padEnd(8)} ${row.answer} (used ${row.used})`;
		},
	);
	const actions = () => rows(ACTIONS, accountId);
	await section(say, "The actions (one row for each action)", actions, (row) => `${row.tool} ${row.status}`);
	await printCosts(say, accountId, taskId);
	await printView(say, accountId);
}

async function printTrail(say, accountId, taskId) {
	const path = `/v1/admin/accounts/${accountId}/tasks/${taskId}/trail?readId=${accountId}-read`;
	say("\n== The trail of the task (admin trail call)");
	for (const row of (await api(path, adminToken)).body.rows) {
		const where = `${row.attemptNo ?? "-"}/${row.turnNo ?? "-"}`;
		say(`   ${where} ${row.kind.padEnd(20)} ${row.actor.padEnd(8)} ${row.summary}`);
	}
}

async function printCosts(say, accountId, taskId) {
	say("\n== The cost rows of the task (millionths of a US dollar; a sandbox row depends on the time)");
	const costs = `SELECT kind, provider, model, units, unit, amount FROM costs WHERE account_id = $1 AND task_id = $2
		ORDER BY at, source_ref`;
	for (const row of await rows(costs, accountId, taskId)) {
		const [units, amount] = TIMED.has(row.kind) ? ["<time>", "<time>"] : [row.units, row.amount];
		say(`   ${row.kind.padEnd(15)} ${`${row.provider}/${row.model}`.padEnd(20)} ${units} ${row.unit} = ${amount}`);
	}
}

async function printView(say, accountId) {
	say("\n== The cost view of the account (admin view; the sandbox time differs between runs)");
	const view = (await api("/v1/admin/views/account", adminToken)).body.rows;
	const row = view.find((item) => item.account_id === accountId);
	for (const [name, value] of Object.entries(row)) say(`   ${name.padEnd(16)} ${TIMED.has(name) ? "<time>" : value}`);
}

// Two outputs are the same when they are the same after the ids and the times are removed.
const normal = (run) => run.lines.map((line) => line.replaceAll(run.accountId, "<account>"));

async function twice(proxy, stamp) {
	const first = normal(await runDemo(proxy, `eval-demo-${stamp}-1`, false));
	console.log("\n######## The second run, on a new account\n");
	const second = normal(await runDemo(proxy, `eval-demo-${stamp}-2`, false));
	const length = Math.max(first.length, second.length);
	const diff = Array.from({ length }, (_, i) => i).filter((i) => first[i] !== second[i]);
	console.log("\n== The comparison of the two runs, without the ids and the times");
	for (const i of diff) console.log(`- ${first[i]}\n+ ${second[i]}`);
	if (diff.length === 0) console.log(`   The same: ${first.length} lines.`);
	process.exitCode = diff.length === 0 ? 0 : 1;
}

const MODES = {
	fixed: (proxy, stamp) => runDemo(proxy, `eval-demo-${stamp}-f`, false),
	kill: (proxy, stamp) => runDemo(proxy, `eval-demo-${stamp}-k`, true),
	twice,
};

async function main(mode) {
	if (!MODES[mode]) throw new Error(`Unknown mode ${mode}. Use fixed, kill or twice.`);
	await db.connect();
	const proxy = new RunnerProxy();
	await proxy.start();
	const launcher = startLauncher(proxy);
	try {
		// The test prices. Each command id is fixed, so a second run adds no new price.
		const startsAt = "2026-01-01T00:00:00.000Z";
		for (const [i, price] of PRICES.entries()) {
			await admin({ type: "SetUnitPrice", commandId: `demo-price-${i}`, startsAt, ...price });
		}
		await MODES[mode](proxy, Date.now().toString(36));
	} finally {
		launcher.kill("SIGTERM");
		proxy.server.close();
		await db.end();
	}
}

await main(process.argv[2] ?? "fixed");
