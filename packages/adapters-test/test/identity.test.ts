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
