// The test adapter of the identity port. It knows two owners and one super admin.
import { type Plugin, type Principal, ports } from "@tensquads/core";

export const TEST_TOKENS = {
	ownerA: "owner-a",
	ownerB: "owner-b",
	superAdmin: "super-admin",
} as const;

export const TEST_PRINCIPALS: Readonly<Record<keyof typeof TEST_TOKENS, Principal>> = {
	ownerA: { kind: "owner", ownerId: "owner-a", accountId: "account-a" },
	ownerB: { kind: "owner", ownerId: "owner-b", accountId: "account-b" },
	superAdmin: { kind: "super_admin", adminId: "super-admin" },
};

const byToken = new Map<string, Principal>([
	[TEST_TOKENS.ownerA, TEST_PRINCIPALS.ownerA],
	[TEST_TOKENS.ownerB, TEST_PRINCIPALS.ownerB],
	[TEST_TOKENS.superAdmin, TEST_PRINCIPALS.superAdmin],
]);

// An eval account (requirement E2) has an id that starts with "eval-". With the option evalOwners, the token
// "eval-owner:{accountId}" gives the owner of that account. Each run of an eval case thus has a new account.
const EVAL_ACCOUNT = "eval-";
const EVAL_TOKEN = "eval-owner:";

export const evalOwnerToken = (accountId: string): string => `${EVAL_TOKEN}${accountId}`;
export const evalOwnerRef = (accountId: string): string => `owner-${accountId}`;

function evalOwner(token: string): Principal | undefined {
	const accountId = token.startsWith(EVAL_TOKEN) ? token.slice(EVAL_TOKEN.length) : "";
	if (!accountId.startsWith(EVAL_ACCOUNT)) return undefined;
	return { kind: "owner", ownerId: evalOwnerRef(accountId), accountId };
}

export function testIdentity(options: { evalOwners?: boolean } = {}): Plugin {
	return {
		name: "identity-test",
		provides: [ports.identity],
		needs: [],
		apply: (ctx) => {
			ctx.provide(ports.identity, {
				whoIs: async (token) => {
					const principal = byToken.get(token) ?? (options.evalOwners ? evalOwner(token) : undefined);
					return principal ? { ...principal } : undefined;
				},
			});
		},
	};
}
