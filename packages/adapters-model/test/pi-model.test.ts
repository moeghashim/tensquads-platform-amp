// The tests of the real model adapter. They use a fake fetch function, so no request goes to a provider.
import assert from "node:assert/strict";
import test from "node:test";
import { type Model, type ModelRequest, ports, startSystem } from "@tensquads/core";
import { modelContract } from "@tensquads/core/contract-tests";

import { keyName, MODEL_PROVIDERS, type ModelProvider, piModel } from "../src/index.js";

// A fake key. It is long, so a test can look for each part of it.
const KEY = "sk-test-0123456789abcdefghijklmnopqrstuvwxyz";

interface Seen {
	url: string;
	authorization: string | null;
	body: Record<string, unknown>;
}

const sse = (events: readonly unknown[]) =>
	new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});

// The OpenAI Responses API: one function call or one text, then the usage.
function responsesStream(toolCall: boolean): Response {
	const item = toolCall
		? { type: "function_call", id: "fc_1", call_id: "call_1", name: "answer_owner", arguments: '{"text":"Hi"}' }
		: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello owner", annotations: [] }],
			};
	return sse([
		{ type: "response.created", response: { id: "resp_1", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
			},
		},
	]);
}

// The chat completions API of DeepSeek, GLM and others: one text, then the usage.
function completionsStream(): Response {
	const chunk = (delta: unknown, finish: string | null) => ({
		id: "cmpl-1",
		object: "chat.completion.chunk",
		created: 1,
		model: "deepseek-flash",
		choices: [{ index: 0, delta, finish_reason: finish }],
	});
	return new Response(
		[
			chunk({ role: "assistant", content: "Hello owner" }, null),
			chunk({}, "stop"),
			{ ...chunk({}, null), choices: [], usage: { prompt_tokens: 80, completion_tokens: 4, total_tokens: 84 } },
		]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.concat("data: [DONE]\n\n")
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

function fakeFetch(seen: Seen[], answer: (url: string) => Response): typeof fetch {
	return async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
		const text = input instanceof Request ? await input.text() : String(init?.body ?? "{}");
		seen.push({
			url,
			authorization: headers.get("authorization"),
			body: JSON.parse(text) as Record<string, unknown>,
		});
		return answer(url);
	};
}

async function realModel(provider: ModelProvider, model: string, fetch: typeof globalThis.fetch): Promise<Model> {
	const secrets: Record<string, string> = { [keyName(provider)]: KEY };
	const system = await startSystem([piModel({ provider, model, secret: (name) => secrets[name], fetch })]);
	return system.port(ports.petraModel);
}

const REQUEST: ModelRequest = {
	messages: [
		{ role: "system", content: "You are Petra." },
		{ role: "user", content: "[command c-1 on chat] Hello" },
	],
	tools: ["answer_owner"],
	toolDefinitions: [
		{
			name: "answer_owner",
			description: "Answer the owner with a text.",
			parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		},
	],
};

modelContract("piModel openai", () =>
	realModel(
		"openai",
		"gpt-6.2-sol",
		fakeFetch([], () => responsesStream(true)),
	),
);

test("N7: the adapter serves the seven providers of decision D24, and the key of each one has its own secret", () => {
	assert.deepEqual(MODEL_PROVIDERS, ["openai", "anthropic", "xai", "meta", "google", "deepseek", "zai"]);
	assert.equal(keyName("openai"), "OPENAI_API_KEY");
	assert.equal(keyName("zai"), "ZAI_API_KEY");
});

test("N7: with OpenAI, the adapter sends the instructions, the tools and the key, and returns the tool call and the usage", async () => {
	const seen: Seen[] = [];
	const model = await realModel(
		"openai",
		"gpt-6.2-sol",
		fakeFetch(seen, () => responsesStream(true)),
	);
	assert.deepEqual(model.id, { provider: "openai", model: "gpt-6.2-sol" });
	const answer = await model.complete(REQUEST);
	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.url, "https://api.openai.com/v1/responses");
	assert.equal(seen[0]?.authorization, `Bearer ${KEY}`);
	assert.match(JSON.stringify(seen[0]?.body), /You are Petra\./);
	assert.match(JSON.stringify(seen[0]?.body), /"name":"answer_owner","description":"Answer the owner with a text\."/);
	assert.deepEqual(answer.toolCalls, [{ id: answer.toolCalls[0]?.id, name: "answer_owner", input: { text: "Hi" } }]);
	assert.equal(answer.provider, "openai");
	assert.equal(answer.model, "gpt-6.2-sol");
	assert.equal(answer.requestId, "resp_1");
	assert.deepEqual(answer.usage, { inputTokens: 120, outputTokens: 30 });
});

test("N7: with DeepSeek and a base URL setting, the same adapter calls the other address and returns the text", async () => {
	const seen: Seen[] = [];
	const secrets: Record<string, string> = { DEEPSEEK_API_KEY: KEY };
	const system = await startSystem([
		piModel({
			provider: "deepseek",
			model: "deepseek-flash",
			baseUrl: "https://models.example.test/v1",
			secret: (name) => secrets[name],
			fetch: fakeFetch(seen, () => completionsStream()),
		}),
	]);
	const answer = await system.port(ports.petraModel).complete(REQUEST);
	assert.equal(seen[0]?.url, "https://models.example.test/v1/chat/completions");
	assert.equal(answer.text, "Hello owner");
	assert.equal(answer.provider, "deepseek");
	assert.deepEqual(answer.usage, { inputTokens: 80, outputTokens: 4 });
});

test("N3: a missing key stops the start, and the error names the secret", async () => {
	await assert.rejects(
		startSystem([piModel({ provider: "anthropic", model: "claude-sonnet-5-5", secret: () => undefined })]),
		/The secret ANTHROPIC_API_KEY is missing\./,
	);
});

// Each part of the key with 6 characters or more. No text may have one of them.
function keyParts(key: string, size = 6): string[] {
	const parts: string[] = [];
	for (let start = 0; start + size <= key.length; start += 1) parts.push(key.slice(start, start + size));
	return parts;
}

test("N3: when the provider refuses the key and repeats it, the error of the adapter has no part of the key", async () => {
	const seen: Seen[] = [];
	const model = await realModel(
		"openai",
		"gpt-6.2-sol",
		fakeFetch(seen, () =>
			Response.json(
				{
					error: {
						message: `Incorrect API key provided: ${KEY}. Key ...${KEY.slice(-4)}`,
						code: "invalid_api_key",
					},
				},
				{ status: 401 },
			),
		),
	);
	const error = await model.complete(REQUEST).then(
		() => assert.fail("The call must fail."),
		(failure: unknown) => failure as Error,
	);
	assert.match(error.message, /The model call to openai\/gpt-6\.2-sol failed: error\. The HTTP status is 401\./);
	const text = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`;
	for (const part of keyParts(KEY)) assert.ok(!text.includes(part), `the error has the part "${part}" of the key`);
	assert.equal(seen.length, 1, "the client does not try again; Petra does (requirement N6)");
});

// The conversation of Petra keeps the tool calls of earlier answers. After a swap they can come from another
// provider, for example an OpenAI id "call_1|fc_1". Anthropic accepts only letters, digits, "_" and "-" in an id.
test("N7: after a swap, the tool call ids of the earlier answers are valid for the new provider", async () => {
	const seen: Seen[] = [];
	const model = await realModel(
		"anthropic",
		"claude-sonnet-5-5",
		fakeFetch(seen, () => Response.json({ error: { message: "stop" } }, { status: 500 })),
	);
	const history: ModelRequest = {
		...REQUEST,
		messages: [
			...REQUEST.messages,
			{
				role: "assistant",
				content: JSON.stringify({
					toolCalls: [{ id: "call_1|fc_1", name: "answer_owner", input: { text: "Hi" } }],
				}),
			},
			{ role: "tool", content: JSON.stringify({ toolCallId: "call_1|fc_1", tool: "answer_owner", output: "sent" }) },
			{ role: "user", content: "[command c-2 on chat] How many bots do I have?" },
		],
	};
	await model.complete(history).catch(() => undefined);
	const body = JSON.stringify(seen[0]?.body);
	const use = /"type":"tool_use","id":"([^"]+)"/.exec(body)?.[1];
	const result = /"type":"tool_result","tool_use_id":"([^"]+)"/.exec(body)?.[1];
	assert.match(use ?? "", /^[a-zA-Z0-9_-]+$/);
	assert.equal(result, use, "the tool result names the same id as the tool call");
});
