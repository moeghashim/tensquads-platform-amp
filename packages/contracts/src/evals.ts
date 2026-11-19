import { z } from "zod";

import { OWNER_MESSAGE_TYPES } from "./messages.js";

// The format of an eval case (docs/ARCHITECTURE.md, section 4.8, requirement E1).
// A case is a file in evals/cases/. The runner of evals plays it through Petra, the launcher and the runner of a bot.

const id = z.string().min(1);

// The outcome of each send of the channel or of the payment in the test account.
const outcome = z.enum(["confirmed", "not_sent", "unknown"]);

// The moment of a step after the first step. The runner waits for it, then sends the step.
// "after the first tool call" holds the next gateway calls of the task until the step is done.
export const STEP_WHEN = ["after the last step", "after the first tool call", "when the task waits"] as const;

const when = z.enum(STEP_WHEN).optional();

// The command of each step. The account, the command id and the time come from the runner.
const ownerMessageStep = z.object({ type: z.literal("OwnerMessage"), text: id, when }).strict();
// The fact is the place of a fact in the memory of the setup, from 0.
const forgetFactStep = z.object({ type: z.literal("ForgetFact"), fact: z.int().nonnegative(), when }).strict();
// The decision is for the newest approval request of the account.
const approvalDecisionStep = z
	.object({ type: z.literal("ApprovalDecision"), decision: z.enum(["approve", "reject"]), when })
	.strict();
// The answer is for the newest question to the owner.
const ownerAnswerStep = z.object({ type: z.literal("OwnerAnswer"), text: id, when }).strict();

const evalStep = z.discriminatedUnion("type", [
	ownerMessageStep,
	forgetFactStep,
	approvalDecisionStep,
	ownerAnswerStep,
]);

// The memory and the rules of the new test account, the outcomes of the services, and the answers of the fixed
// decider for each decision point.
const caseSetup = z
	.object({
		credits: z.int().nonnegative().default(100),
		rules: z.array(z.object({ kind: id, params: z.record(z.string(), z.unknown()) }).strict()).default([]),
		memory: z.array(z.object({ page: id, text: id }).strict()).default([]),
		services: z
			.object({ channel: outcome.default("confirmed"), payment: outcome.default("confirmed") })
			.strict()
			.default({ channel: "confirmed", payment: "confirmed" }),
		decider: z
			.record(
				z.string(),
				z.object({ answer: z.string().optional(), probability: z.number().min(0).max(1).optional() }).strict(),
			)
			.default({}),
	})
	.strict();

const taskStatus = z.enum(["starting", "running", "waiting for the owner", "done", "failed", "cancelled"]);

// One check of the code grader. Each check reads the rows, the messages, the trail and the actions of the run.
const evalCheck = z.discriminatedUnion("check", [
	// The number of tasks that started.
	z.object({ check: z.literal("tasks"), count: z.int().nonnegative() }).strict(),
	// Each task has this status.
	z.object({ check: z.literal("task status"), status: taskStatus }).strict(),
	// The number of messages to the owner of one type.
	z.object({ check: z.literal("messages"), type: z.enum(OWNER_MESSAGE_TYPES), count: z.int().nonnegative() }).strict(),
	// The credits that the run took: the charges less the give-backs.
	z.object({ check: z.literal("credits taken"), credits: z.int().nonnegative() }).strict(),
	// Exactly one action of the tool, with this status and, for a money action, this amount.
	z.object({ check: z.literal("action"), tool: id, status: id, amount: z.number().positive().optional() }).strict(),
	// The number of sends that the port recorded.
	z.object({ check: z.literal("sends"), port: z.enum(["channel", "payment"]), count: z.int().nonnegative() }).strict(),
	// Each action with an approval started after the owner approved it.
	z.object({ check: z.literal("send after approval") }).strict(),
	// At least one trail row of the kind. With a field, the data of the row has a value for that field.
	z.object({ check: z.literal("trail"), kind: id, field: id.optional() }).strict(),
	// The fact of the setup is on the forget list of the task.
	z.object({ check: z.literal("forget list"), fact: z.int().nonnegative() }).strict(),
	// No model request after the forget has the text of the fact. A request before it has the text.
	z.object({ check: z.literal("fact not in model requests after forget"), fact: z.int().nonnegative() }).strict(),
	// The last check of a result of the task stands.
	z.object({ check: z.literal("last check stands") }).strict(),
]);

// The grader: code with the checks of the case, the checker model port, or a person.
const evalGrader = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("code") }).strict(),
	z.object({ kind: z.literal("model") }).strict(),
	z.object({ kind: z.literal("person") }).strict(),
]);

export const evalCase = z
	.object({
		id,
		// Where the case comes from, and how it was adapted.
		source: id,
		tags: z.array(id).default([]),
		setup: caseSetup.default({
			credits: 100,
			rules: [],
			memory: [],
			services: { channel: "confirmed", payment: "confirmed" },
			decider: {},
		}),
		input: z.array(evalStep).min(1),
		expected: z.object({ text: id, checks: z.array(evalCheck).default([]) }).strict(),
		grader: evalGrader,
	})
	.strict()
	.superRefine((value, ctx) => {
		value.input.forEach((step, index) => {
			if (index === 0 && step.when !== undefined) {
				ctx.addIssue({ code: "custom", path: ["input", 0, "when"], message: "The first step has no condition." });
			}
			if (index > 0 && step.when === undefined) {
				ctx.addIssue({ code: "custom", path: ["input", index, "when"], message: "This step needs a condition." });
			}
			if (step.type === "ForgetFact" && step.fact >= value.setup.memory.length) {
				ctx.addIssue({ code: "custom", path: ["input", index, "fact"], message: "The setup has no such fact." });
			}
		});
		if (value.grader.kind === "code" && value.expected.checks.length === 0) {
			ctx.addIssue({ code: "custom", path: ["expected", "checks"], message: "A code grader needs a check." });
		}
	});

export type EvalStep = z.infer<typeof evalStep>;
export type CaseSetup = z.infer<typeof caseSetup>;
export type EvalCheck = z.infer<typeof evalCheck>;
export type EvalCase = z.infer<typeof evalCase>;

// A version (requirement E3): a named settings file in evals/versions/. The worker settings are the vars of the
// Platform Worker: they select the rows of its plug-in lists. The launcher settings go to the launcher and its runners.
export const evalVersion = z
	.object({
		name: id,
		description: id,
		worker: z.record(z.string(), z.string()),
		launcher: z.record(z.string(), z.string()).default({}),
	})
	.strict();

export type EvalVersion = z.infer<typeof evalVersion>;

// One labelled message for the eval of the decider (requirement E5). The rule is for the point "reason-in-rule".
export const deciderItem = z
	.object({
		point: id,
		language: z.enum(["en", "ar"]),
		message: id,
		rule: id.optional(),
		answer: z.enum(["yes", "no"]),
	})
	.strict();

export type DeciderItem = z.infer<typeof deciderItem>;
