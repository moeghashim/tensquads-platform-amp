// Runs the part B scenarios. It serves the journal and action endpoints and starts the runner.
// Without JOURNAL_URL, a small Node server stands in for the test Worker. With JOURNAL_URL, the
// runner sends its copies to the Worker of part A.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

type Copy = { attempt: number; no: number; bytes: Buffer; meta: Record<string, unknown> };
const copies = new Map<string, Copy[]>();
const actions = new Map<string, { content: string; answer: Record<string, unknown>; runs: number }>();
const ran: { task: string; tool: string; callId: string; attempt: number }[] = [];

const server = createServer(async (req, res) => {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const body = Buffer.concat(chunks);
	const url = new URL(req.url ?? "/", "http://x");
	const parts = url.pathname.split("/").filter(Boolean);
	const json = (status: number, value: unknown) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(value));
	};
	if (parts[0] === "journal" && req.method === "PUT") {
		const [attempt, no] = parts[2]!.split("-").map(Number) as [number, number];
		const list = copies.get(parts[1]!) ?? [];
		list.push({ attempt, no, bytes: body, meta: JSON.parse(String(req.headers["x-meta"] ?? "{}")) });
		copies.set(parts[1]!, list);
		return json(200, { ok: true });
	}
	if (parts[0] === "journal" && req.method === "GET") {
		// The largest attempt, then the largest copy number, compared as numbers.
		const list = [...(copies.get(parts[1]!) ?? [])].sort((a, b) => b.attempt - a.attempt || b.no - a.no);
		if (list.length === 0) return json(404, { code: "not_found" });
		res.writeHead(200);
		return res.end(list[0]!.bytes);
	}
	if (parts[0] === "journal" && req.method === "DELETE") {
		copies.delete(parts[1]!);
		return json(200, { ok: true });
	}
	if (parts[0] === "action") {
		const request = JSON.parse(String(body)) as { id: string; content: unknown };
		const content = JSON.stringify(request.content);
		const saved = actions.get(request.id);
		if (saved !== undefined) {
			if (saved.content !== content) return json(200, { status: "refused", ref: "different content" });
			return json(200, saved.answer);
		}
		const answer = { status: "done", ref: `pay-${actions.size + 1}` };
		actions.set(request.id, { content, answer, runs: 1 });
		return json(200, answer);
	}
	if (parts[0] === "ran") {
		ran.push(JSON.parse(String(body)));
		return json(200, { ok: true });
	}
	json(404, { code: "not_found" });
});
await new Promise<void>((resolve) => server.listen(8790, "127.0.0.1", resolve));

type Result = Record<string, unknown> & { kind: string; attempt: number };
function runAttempt(task: string, attempt: number, extra: Record<string, string>): Promise<Result[]> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["b/runner.ts"], {
			env: { ...process.env, TASK: task, ATTEMPT: String(attempt), SERVER: "http://127.0.0.1:8790", ...extra },
			stdio: ["ignore", "pipe", "inherit"],
		});
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.on("exit", () => {
			resolve(
				out
					.split("\n")
					.filter((line) => line.startsWith("RESULT "))
					.map((line) => JSON.parse(line.slice(7)) as Result),
			);
		});
	});
}
async function runTask(task: string, extra: Record<string, string> = {}) {
	// Each run starts with no journal copy of the task.
	await fetch(`${process.env.JOURNAL ?? "http://127.0.0.1:8790"}/journal/${task}`, { method: "DELETE" });
	const first = await runAttempt(task, 1, extra);
	const killed = first.find((r) => r.kind === "killed");
	const second = killed === undefined ? [] : await runAttempt(task, 2, extra);
	return { first, second, killed: killed?.point, end: [...first, ...second].find((r) => r.kind === "end") };
}

const report: string[] = [];
const verdict = (id: string, pass: boolean, detail: string) => {
	report.push(`${pass ? "PASS" : "FAIL"} ${id}: ${detail}`);
	console.log(report.at(-1));
};
const only = process.argv.slice(2);
const want = (id: string) => only.length === 0 || only.includes(id);

if (want("SP-B2")) {
	const r = await runTask("b2", { SCENARIO: "basic", STEER: "1" });
	const seen = r.end?.seen as { results: number; users: string[] }[];
	const firstWithSteer = seen.findIndex((s) => s.users.some((u) => u.startsWith("steer:")));
	verdict(
		"SP-B2",
		r.end?.status === "done" && firstWithSteer > 0 && seen[firstWithSteer]!.results >= 1,
		`steer was submitted during the slow tool; the model first got it in request ${firstWithSteer + 1}, after ${seen[firstWithSteer]?.results} tool result(s)`,
	);
}
if (want("SP-B3") || want("SP-B5")) {
	const r = await runTask("b5", { SCENARIO: "basic", KILL_AT: "mid-tool" });
	const all = [...r.first, ...r.second].filter((x) => x.kind === "end");
	const seen = (r.end?.seen ?? []) as { hasSecret: boolean }[];
	const slowRuns = ran.filter((x) => x.task === "b5" && x.tool === "slow");
	verdict(
		"SP-B3",
		r.killed === "mid-tool" && seen.length > 0 && seen.every((s) => !s.hasSecret),
		`killed during a tool; the new process made ${seen.length} model request(s); the forgotten text was in ${seen.filter((s) => s.hasSecret).length} of them`,
	);
	verdict(
		"SP-B5",
		r.killed === "mid-tool" && r.end?.status === "done" && all.length === 1,
		`killed during the slow tool of turn 1; the new process resumed from the last copy and ended "${r.end?.status}". The slow tool ran ${slowRuns.length} time(s) (attempts ${slowRuns.map((x) => x.attempt).join(", ")}) with call id ${[...new Set(slowRuns.map((x) => x.callId))].join(", ")}; model calls in the new process: ${r.end?.modelCalls}`,
	);
}
if (want("SP-B5")) {
	const r = await runTask("b5b", { SCENARIO: "basic", KILL_AT: "mid-lookup" });
	const runs = ran.filter((x) => x.task === "b5b");
	const fmt = (tool: string) =>
		runs
			.filter((x) => x.tool === tool)
			.map((x) => `attempt ${x.attempt} ${x.callId}`)
			.join(", ");
	verdict(
		"SP-B5 (turn 2)",
		r.killed === "mid-lookup" && r.end?.status === "done",
		`killed during the lookup of turn 2, after the copy of turn 1. slow: ${fmt("slow")}. lookup: ${fmt("lookup")}. Model calls in the new process: ${r.end?.modelCalls}`,
	);
}
if (want("SP-B6")) {
	const r = await runTask("b6", { SCENARIO: "action", KILL_AT: "after-copy" });
	const copied = r.first.filter((x) => x.kind === "copy" && x.label === "before-action").map((x) => x.callId);
	const sent = [...actions.keys()].filter((id) => id.startsWith("b6/")).map((id) => id.slice(3));
	const ids = [...copied, ...sent];
	const action = [...actions.entries()].filter(([id]) => id.startsWith("b6/"));
	verdict(
		"SP-B6",
		r.killed === "after-copy" && new Set(ids).size === 1 && action.length === 1,
		`killed after the copy before the action; the call id before the kill and after the resume: ${ids.join(" and ")}; actions done: ${action.length}. The id comes from the tool call in the model answer, which the journal stores`,
	);
	const t30 = await runTask("b6-30", { SCENARIO: "turns", TURNS: "30" });
	verdict(
		"SP-B6 (30 turns)",
		t30.end?.uniqueCallIds === 30,
		`a task of 30 tool calls has ${t30.end?.uniqueCallIds} different call ids`,
	);
}
if (want("SP-B7")) {
	for (const turns of ["3", "30"]) {
		const r = await runTask(`b7-${turns}`, { SCENARIO: "turns", TURNS: turns });
		const sizes = r.first.filter((x) => x.kind === "copy");
		const last = sizes.at(-1) as { bytes: number; ms: number } | undefined;
		const avg = sizes.reduce((s, x) => s + (x.ms as number), 0) / Math.max(1, sizes.length);
		verdict(
			`SP-B7 (${turns} turns)`,
			r.end?.status === "done",
			`${sizes.length} copies; the last copy is ${last?.bytes} bytes; the mean time to make and send one copy is ${avg.toFixed(1)} ms`,
		);
	}
}
if (want("SP-B9")) {
	await runTask("b9-a", { SCENARIO: "turns", TURNS: "3" });
	const J = process.env.JOURNAL ?? "http://127.0.0.1:8790";
	await fetch(`${J}/journal/b9-a`, { method: "DELETE" });
	const gone = (await fetch(`${J}/journal/b9-a/latest`)).status === 404;
	const r = await runTask("b9-b", { SCENARIO: "turns", TURNS: "3" });
	verdict("SP-B9", gone && r.end?.status === "done", `the copies of task A are gone; task B ended "${r.end?.status}"`);
}
if (want("SP-B10")) {
	for (const replay of ["safe", "unsafe"]) {
		const task = `b10-${replay}`;
		const r = await runTask(task, { SCENARIO: "action", KILL_AT: "after-answer", REPLAY: replay });
		const done = [...actions.entries()].filter(([id]) => id.startsWith(`${task}/`));
		const seen = (r.end?.seen ?? []) as { results: number }[];
		verdict(
			`SP-B10 (${replay})`,
			replay === "safe" ? done.length === 1 && r.end?.status === "done" : true,
			`killed after the endpoint answered; distinct action ids sent: ${done.length}; the answer of the model: ${JSON.stringify((r.end as { status?: string })?.status)}; model requests in the new process: ${seen.length}`,
		);
	}
}
if (want("SP-B11")) {
	const r = await runTask("b11", { SCENARIO: "basic", KILL_AT: "mid-tool", EXTRA: "1" });
	const seen = (r.end?.seen ?? []) as { users: string[] }[];
	const lastUsers = seen.at(-1)?.users ?? [];
	const count = (prefix: string) => lastUsers.filter((u) => u.startsWith(prefix)).length;
	verdict(
		"SP-B11",
		r.killed === "mid-tool" && count("Do the task") === 1 && count("steer: second") === 1,
		`killed before the next copy; the new process submitted both messages again with the same request ids; the last model request has the first message ${count("Do the task")} time(s) and the second ${count("steer: second")} time(s)`,
	);
}
server.close();
console.log(`\n${report.join("\n")}`);
process.exit(0);
