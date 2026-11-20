"use client";

import { OwnerMessageView } from "@tensquads/ui/react";
import { ownerAnswerCommand, ownerMessageCommand, type PlatformOwnerCommandBody } from "@tensquads/ui/schemas";
import { type FormEvent, useState } from "react";

import { type OwnerView, openQuestion, ownerView, placeSent, type SentText } from "../lib/owner-messages";
import { useOwnerSession } from "../lib/owner-session";
import { ActivityPanel } from "./activity-panel";
import { SignInForm } from "./sign-in-form";

const ACTION_LABELS: Record<string, string> = { refund: "Refund" };

type Send = (body: PlatformOwnerCommandBody, text?: string) => void;

function SentTexts({ items }: { items: readonly SentText[] | undefined }) {
	return items?.map((item) => (
		<p key={`${item.afterSeq}-${item.text}`} className="owner-sent">
			{item.text}
		</p>
	));
}

function MessageList({
	view,
	sent,
	thinking,
	send,
}: {
	view: OwnerView;
	sent: SentText[];
	thinking: boolean;
	send: Send;
}) {
	const places = placeSent(view, sent);
	return (
		<section className="owner-messages" aria-live="polite">
			{view.messages.length === 0 ? <p className="owner-empty">No messages yet. Say hello to Petra.</p> : null}
			<SentTexts items={places.get(-1)} />
			{view.messages.map((message, index) => (
				<div key={String(message.seq)} className="owner-turn">
					<OwnerMessageView
						messages={[message]}
						actionLabels={ACTION_LABELS}
						approvalDecisions={view.decisions}
						onCommand={(body) => send(body)}
					/>
					<SentTexts items={places.get(index)} />
				</div>
			))}
			{thinking ? <p className="owner-thinking">Petra is thinking…</p> : null}
		</section>
	);
}

// The text box. While Petra waits for an answer to her question, the text is the answer.
function Composer({ view, send }: { view: OwnerView; send: Send }) {
	const [draft, setDraft] = useState("");
	const question = openQuestion(view);

	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const text = draft.trim();
		if (!text) return;
		setDraft("");
		// Petra keeps her own question in her conversation, so a plain message answers it.
		const body =
			question && !question.fromPetra
				? ownerAnswerCommand({ questionId: question.questionId, text })
				: ownerMessageCommand({ messageId: crypto.randomUUID(), channel: "web", text });
		send(body, text);
	}

	return (
		<form className="owner-composer" onSubmit={onSubmit}>
			<input
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				placeholder={question ? `Answer: ${question.text}` : "Write to Petra"}
				aria-label="Message to Petra"
			/>
			<button type="submit" disabled={!draft.trim()}>
				Send
			</button>
		</form>
	);
}

export function OwnerChat() {
	const session = useOwnerSession();
	if (!session.token) return <SignInForm error={session.error} onSignIn={session.signIn} />;

	const view = ownerView(session.messages);
	const send: Send = (body, text) => void session.send(body, text);
	return (
		<main className="owner-layout">
			<div className="owner-shell">
				<header className="owner-header">
					<h1>Petra</h1>
					<button type="button" className="owner-link" onClick={() => session.signOut()}>
						Sign out
					</button>
				</header>
				<MessageList view={view} sent={session.sent} thinking={session.thinking} send={send} />
				<Composer view={view} send={send} />
				{session.error ? <p className="owner-error">{session.error}</p> : null}
			</div>
			<ActivityPanel lines={session.activity} />
		</main>
	);
}
