// The proposals of the night job for the core (docs/ARCHITECTURE.md, section 10.1, requirement M10).
// The night job reads the messages of the owner of one local day. It only proposes: it never writes to the core.
// It proposes three items or fewer for each ISO week. The evidence of a proposal has ids of messages only.

// At most three proposals in one ISO week (requirement M10).
export const WEEK_LIMIT = 3;
// The first line of the request of the night job. The test model reads it (packages/adapters-test).
export const NIGHT_MARKER = "Night job: propose items for the core.";
const DAY_MS = 24 * 60 * 60 * 1000;

// One message of the owner: the source reference of its row, and its text.
export interface DayMessage {
	id: string;
	text: string;
}

export interface NewProposal {
	week: string;
	n: number;
	kind: "core item";
	text: string;
	evidence: readonly string[];
}

// The part of the model port that the night job uses. A is the answer of the model.
export interface ProposalModel<A extends { text: string } = { text: string }> {
	complete(request: { messages: { role: "user"; content: string }[]; tools: string[] }): Promise<A>;
}

// Writes the cost rows of one answer of the model (requirement N4). The cause is "night/{date}".
export type ProposalCost<A> = (cause: string, answer: A) => Promise<void>;

export interface ProposalStore {
	// The evidence of each proposal of the week.
	weekProposals(week: string): Promise<{ evidence: string[] }[]>;
	// A second write with the same week and number changes nothing.
	addProposal(proposal: NewProposal): Promise<void>;
}

// The ISO week of a date, for example "2026-W47". The week starts on Monday.
export function isoWeek(date: string): string {
	const day = new Date(`${date}T00:00:00.000Z`);
	const weekday = day.getUTCDay() || 7;
	// The Thursday of the same week gives the year of the week.
	const thursday = new Date(day.getTime() + (4 - weekday) * DAY_MS);
	const year = thursday.getUTCFullYear();
	const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1;
	return `${year}-W${String(week).padStart(2, "0")}`;
}

// The model answers a JSON list of { text, evidence }. Each other answer gives no proposal.
function parseAnswer(text: string): { text: string; evidence: string[] }[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.flatMap((item: { text?: unknown; evidence?: unknown }) =>
		typeof item?.text === "string" && Array.isArray(item.evidence)
			? [{ text: item.text, evidence: item.evidence.filter((id): id is string => typeof id === "string") }]
			: [],
	);
}

// Proposes items from the messages of one day. Returns the number of new proposals.
export async function proposeDay<A extends { text: string }>(
	deps: { store: ProposalStore; model: ProposalModel<A>; cost?: ProposalCost<A> },
	day: { date: string; messages: readonly DayMessage[] },
): Promise<number> {
	if (day.messages.length === 0) return 0;
	const week = isoWeek(day.date);
	const existing = await deps.store.weekProposals(week);
	if (existing.length >= WEEK_LIMIT) return 0;
	const lines = day.messages.map((message) => `[${message.id}] ${message.text}`);
	const answer = await deps.model.complete({
		messages: [{ role: "user", content: [NIGHT_MARKER, ...lines].join("\n") }],
		tools: [],
	});
	await deps.cost?.(`night/${day.date}`, answer);
	// Our code keeps only the ids of the messages that it gave. The model never adds an id or a text as evidence.
	const known = new Set(day.messages.map((message) => message.id));
	const used = new Set(existing.flatMap((proposal) => proposal.evidence));
	let n = existing.length;
	for (const proposal of parseAnswer(answer.text)) {
		const evidence = proposal.evidence.filter((id) => known.has(id));
		// A night job that runs again finds its proposals by their evidence and writes no second one.
		if (n >= WEEK_LIMIT || evidence.length === 0 || evidence.some((id) => used.has(id))) continue;
		n += 1;
		await deps.store.addProposal({ week, n, kind: "core item", text: proposal.text, evidence });
		for (const id of evidence) used.add(id);
	}
	return n - existing.length;
}
