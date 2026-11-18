// The pass of one attempt (docs/ARCHITECTURE.md, section 3.4, requirement L9).
// The form is base64url(JSON of the claims) "." base64url(HMAC-SHA256 of the first part).
// The code uses Web Crypto only, so it runs in a Worker and in Node.
import { type PassClaims, passClaims } from "@tensquads/contracts";

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// Returns undefined for text that is not base64url.
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
	try {
		const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch {
		return undefined;
	}
}

function hmacKey(key: string, usage: "sign" | "verify"): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function signPass(claims: PassClaims, key: string): Promise<string> {
	const body = toBase64Url(encoder.encode(JSON.stringify(passClaims.parse(claims))));
	const signature = await crypto.subtle.sign("HMAC", await hmacKey(key, "sign"), encoder.encode(body));
	return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

// Returns the claims, or undefined for a bad form, a bad signature, or a time at or after the end time.
// crypto.subtle.verify compares the signature in constant time.
export async function verifyPass(token: string, key: string, now: number): Promise<PassClaims | undefined> {
	const parts = token.split(".");
	if (parts.length !== 2) return undefined;
	const [body, signaturePart] = parts as [string, string];
	const signature = fromBase64Url(signaturePart);
	if (!signature || body.length === 0) return undefined;
	const valid = await crypto.subtle.verify("HMAC", await hmacKey(key, "verify"), signature, encoder.encode(body));
	if (!valid) return undefined;
	const bytes = fromBase64Url(body);
	if (!bytes) return undefined;
	let json: unknown;
	try {
		json = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return undefined;
	}
	const claims = passClaims.safeParse(json);
	if (!claims.success || now >= claims.data.endsAt) return undefined;
	return claims.data;
}
