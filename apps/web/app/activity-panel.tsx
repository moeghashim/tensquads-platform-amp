"use client";

import type { ActivityLine } from "../lib/activity";

// The panel on the right: a terminal-like stream of what happens behind the chat.
export function ActivityPanel({ lines }: { lines: readonly ActivityLine[] }) {
	return (
		<aside className="owner-activity" aria-label="What happens in the background">
			<header>Behind the scenes</header>
			<ol>
				{lines.map((line, index) => (
					<li
						key={line.id}
						className={`activity-${line.kind}`}
						// The newest line scrolls the panel to its end.
						ref={
							index === lines.length - 1
								? (el) => {
										if (el?.parentElement) el.parentElement.scrollTop = el.parentElement.scrollHeight;
									}
								: undefined
						}
					>
						<time>{line.at}</time> {line.text}
					</li>
				))}
				{lines.length === 0 ? <li className="activity-info">Waiting for activity…</li> : null}
			</ol>
		</aside>
	);
}
