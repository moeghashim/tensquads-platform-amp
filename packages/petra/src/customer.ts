// The customer reference (docs/ARCHITECTURE.md, section 7.8). Our code makes it. A model never sets it.
// It is the SHA-256 hash of the account id, the channel and the address of the sender.

export async function customerRef(accountId: string, channel: string, sender: string): Promise<string> {
	const text = `${accountId}\n${channel}\n${sender}`;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
