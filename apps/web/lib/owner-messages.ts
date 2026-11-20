// Maps the owner messages of the Platform Worker to the shapes of @tensquads/ui.
// The UI schemas are strict. The platform adds fields and two message types that the UI does not know:
// - approval_request has amount, bot and taskId: the card gets the other fields.
// - approval_decided gives the decided state of a card, and question_answered closes a question.

export interface WorkerMessage {
	seq: number;
	type: string;
	[field: string]: unknown;
}

export interface OwnerView {
	// The messages for OwnerMessageView, in the order of seq.
	messages: Record<string, unknown>[];
	// The decision of each approval that Petra applied.
	decisions: Record<string, "approve" | "reject">;
	// The questions that Petra already took an answer for.
	answered: Set<string>;
}

export function ownerView(list: readonly WorkerMessage[]): OwnerView {
	const messages: Record<string, unknown>[] = [];
	const decisions: Record<string, "approve" | "reject"> = {};
	const answered = new Set<string>();
	for (const message of list) {
		if (message.type === "approval_decided") {
			const decision = message.decision === "reject" ? "reject" : "approve";
			decisions[String(message.approvalId)] = decision;
		} else if (message.type === "question_answered") {
			answered.add(String(message.questionId));
		} else if (message.type === "approval_request") {
			const { amount: _amount, bot: _bot, taskId: _taskId, ...card } = message;
			messages.push(card);
		} else {
			messages.push(message);
		}
	}
	return { messages, decisions, answered };
}

// Adds new messages to the list. A message with a seq that is already in the list is skipped.
// With no new message, it returns the same list, so React does not render again.
export function mergeMessages(list: WorkerMessage[], fresh: readonly WorkerMessage[]): WorkerMessage[] {
	const known = new Set(list.map((message) => message.seq));
	const added = fresh.filter((message) => !known.has(message.seq));
	if (added.length === 0) return list;
	return [...list, ...added].sort((a, b) => a.seq - b.seq);
}

// The questions that Petra asks herself, with no task: "{commandId}/ask" and the decision points. The platform
// takes an OwnerAnswer only for a question of a task, so the answer to one of these goes as an owner message.
const PETRA_QUESTION = /\/(ask|request-clear|which-bot|message-for-task|which)$/;

// A question is open while it is the newest message of Petra and Petra took no answer for it.
export function openQuestion(view: OwnerView): { questionId: string; text: string; fromPetra: boolean } | undefined {
	const newest = view.messages.at(-1);
	if (newest?.type !== "question") return undefined;
	const questionId = String(newest.questionId);
	if (view.answered.has(questionId)) return undefined;
	return { questionId, text: String(newest.text), fromPetra: PETRA_QUESTION.test(questionId) };
}

export interface SentText {
	afterSeq: number;
	text: string;
}

// Puts each text of the owner after the last shown message with a seq at or below its afterSeq. A hidden message
// (approval_decided, question_answered) can be the newest one when the owner sends. Index -1 is before all messages.
export function placeSent(view: OwnerView, sent: readonly SentText[]): Map<number, SentText[]> {
	const places = new Map<number, SentText[]>();
	for (const item of sent) {
		let index = -1;
		view.messages.forEach((message, at) => {
			if (Number(message.seq) <= item.afterSeq) index = at;
		});
		places.set(index, [...(places.get(index) ?? []), item]);
	}
	return places;
}
