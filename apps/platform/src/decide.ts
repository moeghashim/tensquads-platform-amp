// Joins the decisions package to Petra and to the gate (task 09). No plug-in imports another plug-in (C2),
// so the app gives each one the part of the other that it needs.
import type { Decisions } from "@tensquads/decisions";
import type { GateDeps } from "@tensquads/gate";
import type { DecisionReader } from "@tensquads/petra";

// The three points of a refund, in one call (requirement Q2). The order is the order of the plan.
const REFUND_POINTS = ["refund-request", "reason-in-rule", "message-safe"] as const;

// The part of the decision writer of Petra that the join reads.
type MessageStore = Pick<DecisionReader, "customerMessage">;

// The check of a money_limit rule with reasons. The gate asks it only at or below the limit. A task with no message
// of a customer gets no "yes", so the owner decides (requirement Q7).
export function refundReasons(decide: Decisions, store: MessageStore): NonNullable<GateDeps["reasons"]> {
	return async ({ taskId, toolCallId, reasons }) => {
		const message = await store.customerMessage(taskId);
		if (!message) return false;
		const verdicts = await decide.ask(
			REFUND_POINTS.map((point) => ({
				sourceRef: `action/${taskId}/${toolCallId}/${point}`,
				point,
				taskId,
				messageSeq: message.seq,
				message: message.text,
				rule: reasons,
			})),
		);
		return verdicts.every((verdict) => verdict.sure && verdict.answer === "yes");
	};
}
