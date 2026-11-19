import assert from "node:assert/strict";
import { test } from "node:test";

import { ports, startSystem } from "@tensquads/core";
import { identityContract } from "@tensquads/core/contract-tests";

import { evalOwnerRef, evalOwnerToken, TEST_PRINCIPALS, TEST_TOKENS, testIdentity } from "../src/index.js";

identityContract("identity-test", async () => (await startSystem([testIdentity()])).port(ports.identity), [
	{ token: TEST_TOKENS.ownerA, principal: { kind: "owner", ownerId: "owner-a", accountId: "account-a" } },
	{ token: TEST_TOKENS.ownerB, principal: { kind: "owner", ownerId: "owner-b", accountId: "account-b" } },
	{ token: TEST_TOKENS.superAdmin, principal: TEST_PRINCIPALS.superAdmin },
]);

test("E2: with eval owners, the token of an eval account gives its owner; another account gets no owner", async () => {
	const identity = (await startSystem([testIdentity({ evalOwners: true })])).port(ports.identity);
	assert.deepEqual(await identity.whoIs(evalOwnerToken("eval-1-k3")), {
		kind: "owner",
		ownerId: evalOwnerRef("eval-1-k3"),
		accountId: "eval-1-k3",
	});
	assert.equal(await identity.whoIs(evalOwnerToken("account-a")), undefined);
	const plain = (await startSystem([testIdentity()])).port(ports.identity);
	assert.equal(await plain.whoIs(evalOwnerToken("eval-1-k3")), undefined);
});

test("N1: with a table of tokens (the secret IDENTITY_TOKENS on staging), the identity knows only those tokens", async () => {
	const owner = { kind: "owner", ownerId: "moe", accountId: "chat-1" } as const;
	const identity = (await startSystem([testIdentity({ tokens: { "token-of-moe": owner } })])).port(ports.identity);
	assert.deepEqual(await identity.whoIs("token-of-moe"), owner);
	assert.equal(await identity.whoIs(TEST_TOKENS.ownerA), undefined);
	assert.equal(await identity.whoIs(TEST_TOKENS.superAdmin), undefined);
});

test("N3: with a table of tokens and eval owners, an eval token works only after the token of a super admin", async () => {
	const tokens = {
		"admin-secret": { kind: "super_admin", adminId: "moe" },
		"owner-secret": { kind: "owner", ownerId: "moe", accountId: "chat-1" },
	} as const;
	const identity = (await startSystem([testIdentity({ evalOwners: true, tokens })])).port(ports.identity);
	// Anyone can guess the plain eval token of a public staging Worker. It must not spend the key of the model.
	assert.equal(await identity.whoIs(evalOwnerToken("eval-1-p2")), undefined);
	assert.equal(await identity.whoIs(evalOwnerToken("eval-1-p2", "owner-secret")), undefined);
	assert.equal(await identity.whoIs(evalOwnerToken("eval-1-p2", "wrong")), undefined);
	assert.deepEqual(await identity.whoIs(evalOwnerToken("eval-1-p2", "admin-secret")), {
		kind: "owner",
		ownerId: evalOwnerRef("eval-1-p2"),
		accountId: "eval-1-p2",
	});
});
