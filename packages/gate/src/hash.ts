// The hash of the content of an action (docs/ARCHITECTURE.md, section 4.4).
// The hash is SHA-256, as hex, of the canonical JSON of { tool, content }. The code uses Web Crypto only.

// JSON with the keys of each object in sorted order. Thus the same content always gives the same text.
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export async function contentHash(tool: string, content: Record<string, unknown>): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalJson({ tool, content }));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The id of an action and of its approval: the task id and the tool-call id (decision D8).
export const actionIdOf = (taskId: string, toolCallId: string): string => `${taskId}/${toolCallId}`;
