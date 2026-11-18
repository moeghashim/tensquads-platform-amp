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

export function testIdentity(): Plugin {
	return {
		name: "identity-test",
		provides: [ports.identity],
		needs: [],
		apply: (ctx) => {
			ctx.provide(ports.identity, {
				whoIs: async (token) => {
					const principal = byToken.get(token);
					return principal ? { ...principal } : undefined;
				},
			});
		},
	};
}
