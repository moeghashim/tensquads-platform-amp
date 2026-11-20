"use client";

export function SignInForm({ error, onSignIn }: { error: string | null; onSignIn: (token: string) => void }) {
	return (
		<main className="owner-shell">
			<form
				className="owner-signin"
				// POST, so that a form sent before the page script runs never puts the token in a URL.
				method="post"
				onSubmit={(event) => {
					event.preventDefault();
					const value = new FormData(event.currentTarget).get("token");
					if (typeof value === "string" && value.trim()) onSignIn(value.trim());
				}}
			>
				<h1>Talk to Petra</h1>
				<p>Enter your owner token.</p>
				<input name="token" type="password" autoComplete="off" aria-label="Owner token" />
				<button type="submit">Sign in</button>
				{error ? <p className="owner-error">{error}</p> : null}
			</form>
		</main>
	);
}
