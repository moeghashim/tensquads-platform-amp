// The six tools of Petra (docs/ARCHITECTURE.md, section 4.6). The loop declares each one replay: "safe".
// Each tool writes by a key from its command, and reads its decision rows first, so a second run changes nothing.
// The input of each tool has the command id, the channel and the text of the owner message.
import type { AccountWriter } from "./account-writer.js";
import type { Outbox } from "./outbox.js";
import type { TaskWork } from "./task-work.js";
import type { TaskReader, TaskRow, TaskWriter } from "./task-writer.js";

// The shape of a tool of the loop package. This package does not import the loop (requirement C2).
export interface PetraToolDefinition {
	name: string;
	description: string;
	execute(input: Record<string, unknown>): Promise<string>;
}

export const PETRA_TOOLS = {
	startTask: "start_task",
	answerOwner: "answer_owner",
	askOwner: "ask_owner",
	readMemory: "read_memory",
	taskStatus: "task_status",
	stopTask: "stop_task",
} as const;

// In task 04, Petra starts each task for the test bot, with one task type.
const TEST_BOT = { bot: "test-bot", taskType: "answer-question" } as const;

export interface PetraToolsDeps {
	writer: Pick<AccountWriter, "finishEvent">;
	tasks: TaskWriter & TaskReader;
	work: TaskWork;
	outbox: Outbox;
	now: () => string;
}

interface ToolInput {
	commandId: string;
	channel: string;
	text: string;
}

function inputOf(input: Record<string, unknown>): ToolInput {
	const { commandId, channel, text } = input;
	if (typeof commandId !== "string" || commandId === "") throw new Error("The tool input has no command id.");
	return {
		commandId,
		channel: typeof channel === "string" && channel !== "" ? channel : "chat",
		text: typeof text === "string" ? text : "",
	};
}

// The task that the text names, or each open task when the text names none.
function targets(open: readonly TaskRow[], text: string): TaskRow[] {
	const named = open.filter((task) => text.includes(task.id));
	return named.length > 0 ? named : [...open];
}

export function petraTools(deps: PetraToolsDeps): PetraToolDefinition[] {
	const { tasks, work, outbox } = deps;

	const reply = (input: ToolInput, text: string, taskId?: string) =>
		outbox.tell({
			sourceRef: `cmd/${input.commandId}/reply`,
			channel: input.channel,
			body: { type: "reply", text },
			...(taskId ? { taskId } : {}),
		});

	// A choice of the code, as a decision row. A second run of the tool reads it and makes the same choice.
	async function decide(input: ToolInput, point: string, choose: () => Promise<string>): Promise<string> {
		const sourceRef = `cmd/${input.commandId}/${point}`;
		const earlier = await tasks.decision(sourceRef, "code");
		if (earlier !== undefined) return earlier;
		const answer = await choose();
		await tasks.addDecision({ sourceRef, decider: "code", taskId: null, point, options: [], answer, at: deps.now() });
		return (await tasks.decision(sourceRef, "code")) ?? answer;
	}

	// The decision point "is this message for a task that runs" (section 4.6). One task that runs gets the message.
	async function startTask(input: ToolInput): Promise<string> {
		const route = await decide(input, "route", async () => {
			const runningTasks = (await tasks.openTasks()).filter((task) => task.status === "running");
			return runningTasks.length === 1 && runningTasks[0] ? runningTasks[0].id : "new task";
		});
		if (route !== "new task") {
			const sourceRef = `cmd/${input.commandId}`;
			await tasks.addInbox({ taskId: route, sourceRef, kind: "message", text: input.text, at: deps.now() });
			await reply(input, `I gave your message to the task ${route}.`, route);
			return `The message went to the inbox of the task ${route}.`;
		}
		const outcome = await work.startTask({
			commandId: input.commandId,
			...TEST_BOT,
			goal: input.text,
			replyTo: input.channel,
		});
		const texts = {
			started: `I started the task ${input.commandId}.`,
			"no credits": "Your credits are not sufficient for this task.",
			ended: `The task ${input.commandId} ended.`,
		} as const;
		await reply(input, texts[outcome], outcome === "no credits" ? undefined : input.commandId);
		return texts[outcome];
	}

	// The tool "stop a task" does the same as the command CancelTask (requirement L15).
	async function stopTask(input: ToolInput): Promise<string> {
		const choice = await decide(input, "stop", async () => {
			const found = targets(await tasks.openTasks(), input.text);
			if (found.length === 0) return "none";
			return found.length === 1 && found[0] ? found[0].id : JSON.stringify(found.map((task) => task.id));
		});
		if (choice === "none") {
			await reply(input, "You have no open task.");
			return "No open task.";
		}
		if (choice.startsWith("[")) {
			// Two open tasks and no clear target: Petra asks which one.
			const options = JSON.parse(choice) as string[];
			await outbox.tell({
				sourceRef: `cmd/${input.commandId}/question`,
				channel: input.channel,
				body: { type: "question", questionId: `${input.commandId}/which`, text: "Which task do I stop?", options },
			});
			return "I asked the owner which task to stop.";
		}
		await work.cancel(choice, "owner");
		return `The task ${choice} is cancelled.`;
	}

	// The status comes from the trail rows of the task (requirement L7).
	async function taskStatus(input: ToolInput): Promise<string> {
		const [task] = targets(await tasks.openTasks(), input.text).reverse();
		if (!task) {
			await reply(input, "You have no open task.");
			return "No open task.";
		}
		const activity = await tasks.taskActivity(task.id, deps.now());
		const detail = activity
			? ` It is in attempt ${activity.attemptNo}, turn ${activity.turnNo ?? 0}. The last row is from ${activity.lastAt}.`
			: "";
		const text = `The task ${task.id} is ${task.status}.${detail}`;
		await reply(input, text, task.id);
		return text;
	}

	const tool = (name: string, description: string, run: (input: ToolInput) => Promise<string>) => ({
		name,
		description,
		async execute(raw: Record<string, unknown>) {
			const input = inputOf(raw);
			const output = await run(input);
			// The command is complete when its tool is complete (section 4.6).
			await deps.writer.finishEvent(input.commandId);
			return output;
		},
	});

	return [
		tool(PETRA_TOOLS.startTask, "Start a task of a bot for the message of the owner.", startTask),
		tool(PETRA_TOOLS.answerOwner, "Answer the owner with a text.", async (input) => {
			await reply(input, input.text);
			return "The answer is sent.";
		}),
		tool(PETRA_TOOLS.askOwner, "Ask the owner a question.", async (input) => {
			await outbox.tell({
				sourceRef: `cmd/${input.commandId}/question`,
				channel: input.channel,
				body: { type: "question", questionId: `${input.commandId}/ask`, text: input.text, options: [] },
			});
			return "The question is sent.";
		}),
		{
			name: PETRA_TOOLS.readMemory,
			description: "Read the memory of the account.",
			// The memory comes in a later task. The tool only reads, so it does not mark a command.
			execute: async () => "The memory has no facts yet.",
		},
		tool(PETRA_TOOLS.taskStatus, "Tell the status of a task.", taskStatus),
		tool(PETRA_TOOLS.stopTask, "Stop a task of the owner.", stopTask),
	];
}
