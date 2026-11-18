// The connections of the three login users of the test database (README.md, Setup).
// The Node tests use them, and the Workers tests get them as bindings. This module imports no package,
// because the vitest config loads it in plain Node.
const ownerUrl = process.env.DATABASE_URL;
const password = process.env.DB_USER_PASSWORD;

function loginUrl(user: string): string {
	if (!ownerUrl || !password) {
		throw new Error("Set DATABASE_URL and DB_USER_PASSWORD. Run npm run db:setup first.");
	}
	const url = new URL(ownerUrl);
	url.username = user;
	url.password = password;
	return url.toString();
}

export function loginConnections(): { petra: string; platform: string; adminViews: string } {
	return {
		petra: loginUrl("ts_petra_login"),
		platform: loginUrl("ts_platform_login"),
		adminViews: loginUrl("ts_admin_views_login"),
	};
}
