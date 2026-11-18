// The contract of the identity port. Each identity adapter must pass these tests.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Identity, Principal } from "../lib/ports.js";

// A token that the adapter knows, and the principal that it must give for the token.
export interface KnownToken {
	token: string;
	principal: Principal;
}

// Registers the tests of the identity port. The make function gives a new identity for each test.
// The adapter sets up the known tokens. The list must have at least one token.
export function identityContract(name: string, make: () => Promise<Identity>, known: readonly KnownToken[]): void {
	describe(`${name}: identity contract`, () => {
		test("a known token gives its principal", async () => {
			assert.ok(known.length > 0, "The contract needs at least one known token.");
			const identity = await make();
			for (const { token, principal } of known) {
				assert.deepEqual(await identity.whoIs(token), principal);
			}
		});

		test("an unknown token gives undefined", async () => {
			const identity = await make();
			assert.equal(await identity.whoIs("token-that-nobody-has"), undefined);
		});

		test("an empty token gives undefined", async () => {
			const identity = await make();
			assert.equal(await identity.whoIs(""), undefined);
		});
	});
}
