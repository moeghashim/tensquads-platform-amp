// The parts of the gate for the Node tests of task 05, against a real Postgres.
// One account with one task of the test bot. The payment and the channel are the test adapters.
// The gateway uses the same gate, so a test can call the gate directly or through the gateway.
import { sendHold, testChannel, testPayment } from "@tensquads/adapters-test";
import type { ActionAnswer, GatewayCall, OwnerMessage } from "@tensquads/contracts";
import { type ChannelMessage, type PaymentOrder, ports, type SendOutcome, startSystem } from "@tensquads/core";
import { type Gate, type GateStore, gate } from "@tensquads/gate";
import type { Gateway } from "@tensquads/gateway";

import { type Harness, harness, harnessGateway, startRunner } from "./task-harness.js";

export const TOOL_LIMIT_MS = 60_000;

export interface GateSetup {
	h: Harness;
	taskId: string;
	paid: PaymentOrder[];
	sent: ChannelMessage[];
	// Each payment waits until release, when the setup has "hold".
	release: () => void;
	gate: Gate;
	gw: Gateway;
	work: ReturnType<Harness["build"]>["work"];
	core: ReturnType<Harness["build"]>["core"];
	// A new gate, as after a stop of Petra: the marks in memory are gone. The services keep their sends.
	restart(store?: GateStore): Gate;
	action(input: {
		attemptNo?: number;
		callNo?: number;
		toolCallId?: string;
		tool?: string;
		content: Record<string, unknown>;
	}): Promise<ActionAnswer | { busy: true }>;
	// The messages to the owner of one type, from the database.
	messages(type: OwnerMessage["type"]): Promise<OwnerMessage[]>;
	// The runner of a new attempt made its start call.
	nextAttempt(causeRef: string): Promise<number>;
}

export interface GateOptions {
	answer?: SendOutcome;
	hold?: boolean;
	// The task comes from an external event of this customer (section 7.8).
	customer?: { sender: string; name: string; at: string };
}

// The status of an answer of the gate, or "busy".
export const statusOf = (answer: ActionAnswer | { busy: true }): string => ("busy" in answer ? "busy" : answer.status);

// The reason of a refusal, or an empty text.
export const reasonOf = (answer: ActionAnswer | { busy: true }): string =>
	"status" in answer && answer.status === "refused" ? answer.reason : "";

export const refund = (amount: number) => ({ amount, to: "cust-1", currency: "USD" });

export async function gateSetup(prefix: string, goal: string, options: GateOptions = {}): Promise<GateSetup> {
	const h = await harness(prefix);
	const { work, out, core } = h.build({
		checkAction: (commandId, actionId) => current.checkJob(commandId, actionId),
	});
	const taskId = `${h.accountId}-task`;
	const eventId = `event-${h.accountId}`;
	if (options.customer) await customerEvent(core, eventId, options.customer);
	await work.startTask({
		commandId: taskId,
		bot: "test-bot",
		taskType: "answer-question",
		goal,
		replyTo: "chat",
		...(options.customer ? { fromEvent: eventId } : {}),
	});
	await startRunner(h, taskId, 1);
	const paid: PaymentOrder[] = [];
	const sent: ChannelMessage[] = [];
	const held = sendHold();
	const sendOptions = { ...(options.answer ? { answer: options.answer } : {}), ...(options.hold ? held : {}) };
	const system = await startSystem([testPayment({ ...sendOptions, paid }), testChannel({ ...sendOptions, sent })]);
	const make = (store: GateStore = h.actions) =>
		gate({
			accountId: h.accountId,
			store,
			tasks: h.tasks,
			payment: system.port(ports.payment),
			channel: system.port(ports.channel),
			tell: (message) => out.tell(message),
			queue: {
				send: async (_queue, body, sendOpts) => {
					h.jobs.push({ body: body as Harness["jobs"][number]["body"], delaySeconds: sendOpts?.delaySeconds });
				},
			},
			toolLimitMs: TOOL_LIMIT_MS,
			now: h.now,
		});
	let current = make();
	const gw = harnessGateway(h, work, { action: (request) => current.action(request) });
	return {
		h,
		taskId,
		paid,
		sent,
		release: held.release,
		get gate() {
			return current;
		},
		gw,
		work,
		core,
		restart(store) {
			current = make(store);
			return current;
		},
		action: ({ attemptNo = 1, callNo = 1, toolCallId = "call-1", tool = "refund", content }) =>
			current.action({ taskId, attemptNo, callNo, bot: "test-bot", toolCallId, tool, content }),
		messages: async (type) => (await h.writer.ownerMessagesAfter(0)).filter((message) => message.type === type),
		async nextAttempt(causeRef) {
			const attempt = (await h.tasks.attempts(taskId)).find((item) => item.causeRef === causeRef);
			if (!attempt) throw new Error(`No attempt has the cause ${causeRef}.`);
			await startRunner(h, taskId, attempt.attemptNo);
			return attempt.attemptNo;
		},
	};
}

// An external event of a customer arrives. Petra writes the event and the message, with the customer reference.
async function customerEvent(
	core: GateSetup["core"],
	eventId: string,
	customer: NonNullable<GateOptions["customer"]>,
): Promise<void> {
	await core.accept(
		{
			type: "ExternalEvent",
			commandId: eventId,
			at: customer.at,
			eventId,
			source: "whatsapp",
			eventType: "message",
			sender: customer.sender,
			payload: { text: `I am ${customer.name}.`, name: customer.name },
		},
		"not trusted",
	);
	await core.work();
}

export const startCall = (callNo: number, runnerId: string): GatewayCall => ({
	call: "start",
	callNo,
	runnerId,
	runnerCommit: "runner-def",
	pluginListHash: "plugins-123",
});

// The row of the action, read from the database.
export async function actionRow(setup: GateSetup, toolCallId = "call-1") {
	return setup.h.actions.action(setup.taskId, toolCallId);
}

// Waits until the held send reached the service. The gate writes rows in the database before the send.
export async function untilSent(list: readonly unknown[], count = 1): Promise<void> {
	for (let i = 0; i < 200 && list.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
	if (list.length < count) throw new Error(`The service did not get ${count} sends.`);
}
