import { ports, startSystem } from "@tensquads/core";
import { identityContract } from "@tensquads/core/contract-tests";

import { TEST_PRINCIPALS, TEST_TOKENS, testIdentity } from "../src/index.js";

identityContract("identity-test", async () => (await startSystem([testIdentity()])).port(ports.identity), [
	{ token: TEST_TOKENS.ownerA, principal: { kind: "owner", ownerId: "owner-a", accountId: "account-a" } },
	{ token: TEST_TOKENS.ownerB, principal: { kind: "owner", ownerId: "owner-b", accountId: "account-b" } },
	{ token: TEST_TOKENS.superAdmin, principal: TEST_PRINCIPALS.superAdmin },
]);
