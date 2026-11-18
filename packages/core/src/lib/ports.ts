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
export interface Database {
	query<Row>(sql: string, params: readonly unknown[]): Promise<Row[]>;
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

export interface ModelRequest {
	messages: readonly ModelMessage[];
	tools: readonly string[];
}

export interface ModelAnswer {
	text: string;
	toolCalls: readonly ModelToolCall[];
	provider: string;
	model: string;
	usage: { inputTokens: number; outputTokens: number };
}

export interface Model {
	complete(request: ModelRequest): Promise<ModelAnswer>;
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
export interface DeciderQuestion {
	id: string;
	point: string;
	text: string;
	options: readonly string[];
}

export interface DeciderAnswer {
	id: string;
	answer: string;
	probability: number;
}

export interface Decider {
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
	pay(order: PaymentOrder): Promise<SendOutcome>;
	status(id: string): Promise<SendOutcome>;
}

export const ports = {
	database: portKey<Database>("database"),
	objectStore: portKey<ObjectStore>("object store"),
	queue: portKey<Queue>("queue"),
	model: portKey<Model>("model"),
	checkerModel: portKey<CheckerModel>("checker model"),
	sandbox: portKey<Sandbox>("sandbox"),
	decider: portKey<Decider>("decider"),
	identity: portKey<Identity>("identity"),
	channel: portKey<Channel>("channel"),
	payment: portKey<Payment>("payment"),
} as const;
