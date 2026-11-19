// The ports of the platform. A port is an interface and a typed key.
// A plug-in provides a port with its key, and another plug-in gets it with the same key.

export interface PortKey<T> {
	readonly name: string;
	// Only for the type. It has no value at run time.
	readonly type?: T;
}

function portKey<T>(name: string): PortKey<T> {
	return { name };
}

// Database. The real adapters are Postgres and Neon (task 03).
// One write is one short transaction. A transaction of Petra names the account first (section 7.1).
export interface Transaction {
	query<Row>(sql: string, params?: readonly unknown[]): Promise<Row[]>;
}

// Who the transaction runs as. The adapter sets the database role, and for Petra the account.
export type DatabaseScope = { role: "petra"; accountId: string } | { role: "platform" } | { role: "admin views" };

export interface Database {
	transaction<T>(scope: DatabaseScope, work: (tx: Transaction) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

// Object store. The real adapter is R2 (task 03).
export interface ObjectStore {
	put(key: string, body: string): Promise<void>;
	get(key: string): Promise<string | undefined>;
	delete(key: string): Promise<void>;
}

// Queue. The real adapter is Cloudflare Queues (task 03).
export type QueueName = "events" | "jobs";

export interface Queue {
	send(queue: QueueName, body: unknown, options?: { delaySeconds?: number }): Promise<void>;
}

// Model. Petra and each bot use it.
export interface ModelMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
}

export interface ModelToolCall {
	id: string;
	name: string;
	input: unknown;
}

// The definition of one tool for a real model: its name, its description and the JSON schema of its input.
export interface ModelToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface ModelRequest {
	messages: readonly ModelMessage[];
	tools: readonly string[];
	// The definitions of the tools. A real adapter gives them to the provider. A test adapter can ignore them.
	toolDefinitions?: readonly ModelToolDefinition[];
	// The caller stops the request with this signal, for example after a time limit (requirement N6).
	signal?: AbortSignal;
}

export interface ModelAnswer {
	text: string;
	toolCalls: readonly ModelToolCall[];
	// The id of the request at the provider. A request that really ran two times has two ids (section 7.1).
	requestId: string;
	provider: string;
	model: string;
	usage: { inputTokens: number; outputTokens: number };
}

export interface Model {
	// The provider and the model that the adapter uses, when the adapter knows them before a call.
	readonly id?: { provider: string; model: string };
	complete(request: ModelRequest): Promise<ModelAnswer>;
}

// The usage of one call to a provider, for one cost row (requirement S1). A token unit is "1M input tokens" or
// "1M output tokens": the price is for one million of them, and the units are tokens.
export interface CallUsage {
	requestId: string;
	provider: string;
	model: string;
	units: number;
	unit: string;
}

// Checker model. It says if the result of a task passes.
export interface CheckRequest {
	taskId: string;
	goal: string;
	result: string;
}

export interface CheckVerdict {
	pass: boolean;
	reason: string;
	// What the call used, for the cost rows.
	usage?: readonly CallUsage[];
}

export interface CheckerModel {
	check(request: CheckRequest): Promise<CheckVerdict>;
}

// Sandbox. One sandbox for each attempt of a task.
export interface SandboxRequest {
	accountId: string;
	taskId: string;
	attemptNo: number;
	pass: string;
}

export interface Sandbox {
	start(request: SandboxRequest): Promise<{ sandboxId: string }>;
}

// Decider. One call has several typed questions. Each answer has a probability (D18, D25).
// The types fit Jev: "yes_no" and "choice" answer with one of the options. A "score" question has no options.
// Its answer is a number from 0 to 1, written as text.
export type DeciderQuestionType = "yes_no" | "choice" | "score";

export interface DeciderQuestion {
	id: string;
	point: string;
	type: DeciderQuestionType;
	text: string;
	options: readonly string[];
}

export interface DeciderAnswer {
	id: string;
	answer: string;
	probability: number;
	// What the call used, for the cost rows. All the answers of one call give the same usage.
	usage?: readonly CallUsage[];
}

// One decision record: one answer of one decider, as one row of the table decisions (requirement Q3).
// It has the seq of the message, never its text.
export interface DecisionRecord {
	// The key of the record, from its cause (section 7.1).
	sourceRef: string;
	decider: string;
	taskId: string | null;
	point: string;
	messageSeq: number | null;
	options: readonly string[];
	// Null after an error or a timeout.
	answer: string | null;
	probability: number | null;
	shadow: boolean;
	// True when the answer passed the checks of the code: valid, and at or above the level.
	used: boolean;
	ms: number | null;
	at: string;
}

export interface Decider {
	// The name of the decider in each decision record.
	readonly name: string;
	ask(questions: readonly DeciderQuestion[]): Promise<DeciderAnswer[]>;
}

// Identity. It says who calls.
export type Principal =
	| { kind: "owner"; ownerId: string; accountId: string }
	| { kind: "super_admin"; adminId: string };

export interface Identity {
	whoIs(token: string): Promise<Principal | undefined>;
}

// The answer of an outside service about one send.
export type SendOutcome = "confirmed" | "not_sent" | "unknown";

// Channel. It sends a message to a customer of the business.
export interface ChannelMessage {
	id: string;
	to: string;
	text: string;
}

export interface Channel {
	// The provider in the cost row of a send (requirement S1).
	readonly name?: string;
	send(message: ChannelMessage): Promise<SendOutcome>;
	status(id: string): Promise<SendOutcome>;
}

// Payment. It moves money, for example a refund.
export interface PaymentOrder {
	id: string;
	to: string;
	amount: number;
	currency: string;
}

export interface Payment {
	// The provider in the cost row of a payment (requirement S1).
	readonly name?: string;
	pay(order: PaymentOrder): Promise<SendOutcome>;
	status(id: string): Promise<SendOutcome>;
}

export const ports = {
	database: portKey<Database>("database"),
	objectStore: portKey<ObjectStore>("object store"),
	queue: portKey<Queue>("queue"),
	model: portKey<Model>("model"),
	// The model of Petra: her loop, her night job and her model decider (decisions D24 and D30). The bots use "model".
	petraModel: portKey<Model>("petra model"),
	checkerModel: portKey<CheckerModel>("checker model"),
	sandbox: portKey<Sandbox>("sandbox"),
	decider: portKey<Decider>("decider"),
	// The second decider of the shadow mode, or null when there is none (requirement Q5).
	shadowDecider: portKey<Decider | null>("shadow decider"),
	identity: portKey<Identity>("identity"),
	channel: portKey<Channel>("channel"),
	payment: portKey<Payment>("payment"),
} as const;
