// A case from the trail of a task (docs/ARCHITECTURE.md, section 4.8, requirement E4).
// The source is an ended task that the owner rejected or changed. The function works only while the trail exists.
// It removes each name, address and number of a customer with the clean function of the memory, which the caller
// gives (this package does not import the memory, requirement C2). It refuses a text that it cannot clean.
import { type EvalCase, type EvalStep, evalCase } from "@tensquads/contracts";

// One row of the trail of a task, as the admin trail call gives it.
export interface TrailCaseRow {
	kind: string;
	actor: string;
	summary: string;
	data: unknown;
}

export interface CustomerData {
	names: readonly string[];
	addresses: readonly string[];
}

export interface TrailCaseInput {
	caseId: string;
	taskId: string;
	rows: readonly TrailCaseRow[];
	// True when the task is still open.
	open: boolean;
	customer: CustomerData;
	clean: (text: string, customer: CustomerData) => string;
}

export type TrailCaseOutcome = { case: EvalCase } | { refused: string };

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u;
// A number with 7 digits or more, also with spaces, dashes, dots or brackets between the digits.
const NUMBER = /\+?\(?\d[\d\s().-]{5,}\d/g;

function stillPersonal(text: string): boolean {
	if (EMAIL.test(text)) return true;
	return [...text.matchAll(NUMBER)].some((match) => match[0].replace(/\D/g, "").length >= 7);
}

const field = (row: TrailCaseRow, name: string): string | undefined => {
	const value = (row.data as Record<string, unknown> | null)?.[name];
	return typeof value === "string" ? value : undefined;
};

// The steps of the owner after the first message: each decision on an approval, and each answer to a question.
function ownerSteps(rows: readonly TrailCaseRow[], clean: (text: string) => string): EvalStep[] {
	return rows.flatMap((row): EvalStep[] => {
		if (row.kind === "approval") {
			const decision = field(row, "status") === "rejected" ? "reject" : "approve";
			return [{ type: "ApprovalDecision", decision, when: "when the task waits" }];
		}
		const answer = row.kind === "decision" && row.actor === "owner" ? field(row, "answer") : undefined;
		return answer ? [{ type: "OwnerAnswer", text: clean(answer), when: "after the last step" }] : [];
	});
}

// What the owner rejected or changed, as the text of the expected outcome.
function changed(rows: readonly TrailCaseRow[], clean: (text: string) => string): string {
	const requests = rows.filter(
		(row) => row.kind === "message to the owner" && field(row, "type") === "approval_request",
	);
	const content = requests.map((row) => clean(field(row, "content") ?? "")).join("; ");
	const rejected = rows.some((row) => row.kind === "approval" && field(row, "status") === "rejected");
	const what = rejected ? `The owner rejected: ${content || "an action"}.` : "The owner changed an answer.";
	return `${what} A person writes the expected outcome.`;
}

export function caseFromTrail(input: TrailCaseInput): TrailCaseOutcome {
	const { rows, taskId } = input;
	if (rows.length === 0) {
		return {
			refused: `The trail of the task ${taskId} was deleted or does not exist. A case can be made only from a trail that exists.`,
		};
	}
	if (input.open) return { refused: `The task ${taskId} is still open. A case comes only from an ended task.` };
	const rejected = rows.some((row) => row.kind === "approval" && field(row, "status") === "rejected");
	const answered = rows.some((row) => row.kind === "decision" && row.actor === "owner");
	if (!rejected && !answered) return { refused: `The owner did not reject or change the task ${taskId}.` };
	const goal = rows.find((row) => row.kind === "owner message");
	const text = goal ? field(goal, "text") : undefined;
	if (!text) return { refused: `The trail of the task ${taskId} has no message of the owner.` };
	const clean = (value: string) => input.clean(value, input.customer);
	const made = evalCase.parse({
		id: input.caseId,
		source: "A trail of a task. The customer data was removed. A person reviews the case.",
		tags: ["from-trail"],
		input: [{ type: "OwnerMessage", text: clean(text) }, ...ownerSteps(rows, clean)],
		expected: { text: changed(rows, clean) },
		grader: { kind: "person" },
	});
	if (stillPersonal(JSON.stringify(made))) {
		return { refused: `The trail of the task ${taskId} cannot be cleaned: an email address or a number stays.` };
	}
	return { case: made };
}
