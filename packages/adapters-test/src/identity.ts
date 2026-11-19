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

// On staging (a table of tokens), the eval token starts with the token of a super admin and a space, because a
// person can guess the plain eval token of a public Worker.
export const evalOwnerToken = (accountId: string, adminToken?: string): string =>
	`${adminToken === undefined ? "" : `${adminToken} `}${EVAL_TOKEN}${accountId}`;
export const evalOwnerRef = (accountId: string): string => `owner-${accountId}`;

function evalOwner(token: string, known: ReadonlyMap<string, Principal> | undefined): Principal | undefined {
	const space = token.indexOf(" ");
	if (known !== undefined && (space < 0 || known.get(token.slice(0, space))?.kind !== "super_admin")) return undefined;
	const rest = known === undefined ? token : token.slice(space + 1);
	const accountId = rest.startsWith(EVAL_TOKEN) ? rest.slice(EVAL_TOKEN.length) : "";
	if (!accountId.startsWith(EVAL_ACCOUNT)) return undefined;
	return { kind: "owner", ownerId: evalOwnerRef(accountId), accountId };
}

// With tokens (on staging, from the secret IDENTITY_TOKENS), the identity knows only those tokens and no test token.
export function testIdentity(
	options: { evalOwners?: boolean; tokens?: Readonly<Record<string, Principal>> } = {},
): Plugin {
	const table = options.tokens ? new Map(Object.entries(options.tokens)) : undefined;
	const known = table ?? byToken;
	return {
		name: "identity-test",
		provides: [ports.identity],
		needs: [],
		apply: (ctx) => {
			ctx.provide(ports.identity, {
				whoIs: async (token) => {
					const principal = known.get(token) ?? (options.evalOwners ? evalOwner(token, table) : undefined);
					return principal ? { ...principal } : undefined;
				},
			});
		},
	};
}
