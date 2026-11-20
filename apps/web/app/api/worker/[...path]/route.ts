// The owner page calls the Platform Worker through this route, so the browser makes no cross-origin call.
// It forwards only the two owner calls, with the token of the owner. It keeps no token.
import { getCloudflareContext } from "@opennextjs/cloudflare";

const WORKER_URL = process.env.PLATFORM_URL ?? "https://tensquads-platform.moe-678.workers.dev";
const ALLOWED = new Set(["v1/commands", "v1/messages"]);

// On Cloudflare, the service binding PLATFORM. Locally and in the tests, there is no Cloudflare context: plain fetch.
function platformFetch(): typeof fetch {
	try {
		const platform = getCloudflareContext().env.PLATFORM;
		return platform.fetch.bind(platform) as typeof fetch;
	} catch {
		return fetch;
	}
}

async function forward(request: Request, path: string[]): Promise<Response> {
	const route = path.join("/");
	if (!ALLOWED.has(route)) return Response.json({ code: "not_found", message: "Not found." }, { status: 404 });
	const query = new URL(request.url).search;
	const headers = new Headers({ "content-type": "application/json" });
	const authorization = request.headers.get("authorization");
	if (authorization) headers.set("authorization", authorization);
	const answer = await platformFetch()(`${WORKER_URL}/${route}${query}`, {
		method: request.method,
		headers,
		body: request.method === "POST" ? await request.text() : undefined,
		cache: "no-store",
	});
	return new Response(answer.body, {
		status: answer.status,
		headers: { "content-type": answer.headers.get("content-type") ?? "application/json" },
	});
}

type Context = { params: Promise<{ path: string[] }> };

export async function GET(request: Request, context: Context): Promise<Response> {
	return forward(request, (await context.params).path);
}

export async function POST(request: Request, context: Context): Promise<Response> {
	return forward(request, (await context.params).path);
}
