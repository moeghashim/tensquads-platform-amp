// The link sends each gateway call of a runner to the Platform Worker (ARCHITECTURE section 3.5).
// It has the shape of the interface Link of the loop. It does not import the loop, because no plug-in imports
// another plug-in (requirement C2). The runner gives the error for a refusal, so the loop knows it.
import {
	type ActionAnswer,
	actionAnswer,
	type GatewayCall,
	type GatewayCallName,
	gatewayBusy,
	gatewayOk,
	gatewayRefusal,
	type InboxAnswer,
	inboxAnswer,
	limitAnswer,
	modelAnswer,
	type ResultAnswer,
	resultAnswer,
	type StartAnswer,
	startAnswer,
	type TaskResult,
} from "@tensquads/contracts";
import type { ModelAnswer, ModelMessage } from "@tensquads/core";

export type RefusalReason = "pass" | "runner" | "attempt" | "task";

export interface HttpLinkOptions {
	// The address of the Platform Worker, with no path.
	workerUrl: string;
	pass: string;
	runnerId: string;
	// The versions that the start call records (requirement L11).
	runnerCommit: string;
	pluginListHash: string;
	// Makes the error for a refusal. The runner stops and exits when it gets this error.
	refused: (reason: RefusalReason, call: GatewayCallName) => Error;
	fetch?: typeof fetch;
	// The time between two tries of one call, after "busy" or after a network error.
	retryDelayMs?: number;
	// The maximum number of tries of one call.
	maxTries?: number;
}

export interface ModelLimit {
	limit: "max_turns" | "max_budget";
}

export interface HttpLink {
	start(): Promise<StartAnswer>;
	model(call: { turnNo: number; messages: ModelMessage[]; tools: string[] }): Promise<ModelAnswer | ModelLimit>;
	step(call: { turnNo: number; toolCallId: string; tool: string; summary: string }): Promise<void>;
	inbox(): Promise<InboxAnswer>;
	journal(copy: string): Promise<void>;
	result(result: TaskResult): Promise<ResultAnswer>;
	// An action tool is one call to `action` (requirement G1).
	action(call: { toolCallId: string; tool: string; content: Record<string, unknown> }): Promise<ActionAnswer>;
	// Saves one changed file to the draft store (requirement G11). The body is base64 text.
	draft(path: string, body: string): Promise<void>;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type CallBody = DistributiveOmit<GatewayCall, "callNo" | "runnerId">;

interface Schema<T> {
	safeParse(value: unknown): { success: true; data: T } | { success: false };
}

type Outcome = { answer: unknown } | { retry: string };

const DEFAULT_RETRY_DELAY_MS = 500;
// With the default delay, a call tries for two minutes. This is more than the time limit of a model call.
const DEFAULT_MAX_TRIES = 240;

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function readJson(response: Response): Promise<unknown> {
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function httpLink(options: HttpLinkOptions): HttpLink {
	const send = options.fetch ?? fetch;
	const url = `${options.workerUrl.replace(/\/+$/, "")}/v1/gateway`;
	const delay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	const maxTries = options.maxTries ?? DEFAULT_MAX_TRIES;
	// The runner counts its calls in one attempt: 1, 2, 3 (section 3.5).
	let lastCallNo = 0;

	// One try of one call. A network error and a server error give a retry with the same call number.
	async function once(call: GatewayCall): Promise<Outcome> {
		let response: Response;
		let json: unknown;
		try {
			response = await send(url, {
				method: "POST",
				headers: { authorization: `Bearer ${options.pass}`, "content-type": "application/json" },
				body: JSON.stringify(call),
			});
			json = await readJson(response);
		} catch (error) {
			return { retry: `network error: ${errorText(error)}` };
		}
		if (response.status === 401) {
			throw options.refused("pass", call.call);
		}
		if (response.status === 403) {
			const refusal = gatewayRefusal.safeParse(json);
			if (!refusal.success) {
				throw new Error(`The gateway answered the call "${call.call}" with the status 403 and no reason.`);
			}
			throw options.refused(refusal.data.refused, call.call);
		}
		if (response.status >= 500) {
			return { retry: `status ${response.status}` };
		}
		if (response.status !== 200) {
			throw new Error(`The gateway answered the call "${call.call}" with the status ${response.status}.`);
		}
		if (gatewayBusy.safeParse(json).success) {
			return { retry: "busy" };
		}
		return { answer: json };
	}

	async function request<T>(body: CallBody, schema: Schema<T>): Promise<T> {
		lastCallNo += 1;
		const call = { ...body, callNo: lastCallNo, runnerId: options.runnerId } as GatewayCall;
		for (let tries = 1; ; tries += 1) {
			const outcome = await once(call);
			if ("answer" in outcome) {
				const parsed = schema.safeParse(outcome.answer);
				if (!parsed.success) {
					throw new Error(`The answer of the gateway to the call "${call.call}" does not pass its schema.`);
				}
				return parsed.data;
			}
			if (tries >= maxTries) {
				throw new Error(`The gateway call "${call.call}" failed after ${tries} tries (${outcome.retry}).`);
			}
			await wait(delay);
		}
	}

	// The model call answers with a model answer or with a limit (requirement L4).
	const modelOrLimit: Schema<ModelAnswer | ModelLimit> = {
		safeParse(value) {
			const limit = limitAnswer.safeParse(value);
			if (limit.success) return limit;
			const answer = modelAnswer.safeParse(value);
			if (!answer.success) return answer;
			const toolCalls = answer.data.toolCalls.map((call) => ({ id: call.id, name: call.name, input: call.input }));
			return { success: true, data: { ...answer.data, toolCalls } };
		},
	};

	return {
		start: () =>
			request(
				{ call: "start", runnerCommit: options.runnerCommit, pluginListHash: options.pluginListHash },
				startAnswer,
			),
		model: (call) => request({ call: "model", ...call }, modelOrLimit),
		step: async (call) => {
			await request({ call: "step", ...call }, gatewayOk);
		},
		inbox: () => request({ call: "inbox" }, inboxAnswer),
		journal: async (copy) => {
			await request({ call: "journal", copy }, gatewayOk);
		},
		result: (result) => request({ call: "result", result }, resultAnswer),
		action: (call) => request({ call: "action", ...call }, actionAnswer),
		draft: async (path, body) => {
			await request({ call: "draft", path, body }, gatewayOk);
		},
	};
}
