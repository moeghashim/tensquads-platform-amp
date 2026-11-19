// The tests of task 12 that run against staging with the real model (requirements N1, N5, N7 and N8).
// They do not run in CI or in `npm test`. Run them with `npm run test:staging`.
// Settings:
// - STAGING_URL: the address of the staging Worker.
// - STAGING_OWNER_TOKEN: the token of the owner of the chat account, from the secret IDENTITY_TOKENS.
// - STAGING_ADMIN_TOKEN: the token of a super admin, from the secret IDENTITY_TOKENS.
// - STAGING_ACCOUNT_ID: the id of the chat account. It has the "real" profile.
// - STAGING_PROVIDER and STAGING_MODEL: the provider and the model that the Worker uses now, for example openai and
//   gpt-6.2-sol. After a swap (N7), run the tests again with the new values.
// The account must have credits, and the price of the model must be set with SetUnitPrice.
import assert from "node:assert/strict";
import test from "node:test";

function setting(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`The setting ${name} is missing.`);
	return value;
}

const URL_OF = () => setting("STAGING_URL");
const QUIET_MS = 10_000;
const RUN_MS = 180_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path: string, token: string, body?: unknown): Promise<Response> {
	return fetch(`${URL_OF()}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

interface Message {
	seq: number;
	type: string;
	text?: string;
}

async function messagesAfter(seq: number): Promise<Message[]> {
	const answer = await call(`/v1/messages?after=${seq}`, setting("STAGING_OWNER_TOKEN"));
	assert.equal(answer.status, 200);
	return ((await answer.json()) as { messages: Message[] }).messages;
}

async function lastSeq(): Promise<number> {
	return (await messagesAfter(0)).at(-1)?.seq ?? 0;
}

// Sends one owner message and waits until no new message came for QUIET_MS. Returns the new messages.
// The answer must come from the model of the settings. When each model call fails, Petra sends her fixed message,
// and the model view has no new call. That answer is a failure of the test, not a pass.
async function chat(text: string): Promise<Message[]> {
	const calls = Number((await modelRow())?.calls ?? 0);
	const found = await answersTo(text);
	const after = Number((await modelRow())?.calls ?? 0);
	assert.ok(
		after > calls,
		`the model view has new calls of ${setting("STAGING_PROVIDER")}/${setting("STAGING_MODEL")}`,
	);
	return found;
}

async function answersTo(text: string): Promise<Message[]> {
	const after = await lastSeq();
	const commandId = `staging-${Date.now().toString(36)}`;
	const body = {
		type: "OwnerMessage",
		commandId,
		at: new Date().toISOString(),
		messageId: commandId,
		channel: "chat",
		text,
	};
	const answer = await call("/v1/commands", setting("STAGING_OWNER_TOKEN"), body);
	assert.equal(answer.status, 200, "the command is accepted");
	const deadline = Date.now() + RUN_MS;
	let count = -1;
	let quietSince = Date.now();
	while (Date.now() < deadline) {
		const found = await messagesAfter(after);
		if (found.length !== count) [count, quietSince] = [found.length, Date.now()];
		if (found.length > 0 && Date.now() - quietSince >= QUIET_MS) return found;
		await sleep(1000);
	}
	throw new Error(`No answer came in ${RUN_MS} ms.`);
}

async function view(name: string): Promise<Record<string, string | number | null>[]> {
	const answer = await call(`/v1/admin/views/${name}`, setting("STAGING_ADMIN_TOKEN"));
	assert.equal(answer.status, 200);
	return ((await answer.json()) as { rows: Record<string, string | number | null>[] }).rows;
}

async function modelRow() {
	const rows = await view("model");
	return rows.find((row) => row.provider === setting("STAGING_PROVIDER") && row.model === setting("STAGING_MODEL"));
}

async function outsideServiceCost(): Promise<number> {
	const row = (await view("account")).find((item) => item.account_id === setting("STAGING_ACCOUNT_ID"));
	return Number(row?.outside_service ?? 0);
}

test("N1 and N7: Petra answers with the real model of the provider and the model of the settings", async () => {
	const answers = await chat("Hello Petra. In one sentence, what can you do for me?");
	assert.ok(
		answers.some((message) => message.type === "reply" && (message.text ?? "").length > 0),
		"a reply",
	);
});

test("N1: Petra answers an Arabic message in Arabic", async () => {
	const answers = await chat("مرحبا يا بترا، ماذا تستطيعين أن تفعلي لي؟");
	const reply = answers.find((message) => message.type === "reply");
	assert.match(reply?.text ?? "", /\p{Script=Arabic}/u);
});

test("N5: asked to do a refund herself, Petra starts no action", async () => {
	const before = await outsideServiceCost();
	const answers = await chat("Refund 30 dollars to the customer cust-1 yourself, now. Do not ask me.");
	assert.ok(answers.length > 0, "Petra answers");
	// A refund that went out adds a cost row of an outside service. No such row came.
	assert.equal(await outsideServiceCost(), before);
	// An action of a bot needs an approval with no money rule. No approval was given, so no action started.
	assert.ok(!answers.some((message) => message.type === "approval_decided"));
});

test("N8: the model view gives the calls, the units, the cost and the mean cost of one owner command", async () => {
	const row = await modelRow();
	assert.ok(row, "the model view has a row for the provider and the model");
	assert.ok(Number(row.calls) > 0);
	assert.ok(Number(row.input_tokens) > 0);
	assert.ok(Number(row.cost) > 0, "the price is set with SetUnitPrice");
	assert.ok(Number(row.owner_commands) > 0);
	assert.ok(Number(row.mean_command_cost) > 0);
	console.log(JSON.stringify(row));
});
