import assert from "node:assert/strict";
import test from "node:test";

import { cleanCustomerText } from "../src/index.js";

const customer = { names: ["Sara Haddad"], addresses: ["+966 55 123 4567"] };

test("M13: the cleaning function removes the name, each part of the name, the address, phone numbers and emails", () => {
	const text =
		"Sara Haddad likes oat milk. Sara pays on Friday. Call +966 55 123 4567 or 050-555-0199, mail sara.h@example.com.";
	const cleaned = cleanCustomerText(text, customer);
	assert.equal(
		cleaned,
		"[removed] likes oat milk. [removed] pays on Friday. Call [removed] or [removed], mail [removed].",
	);
});

test("M13: the cleaning function keeps a text with no data of the customer, and does not cut a longer word", () => {
	assert.equal(cleanCustomerText("Saraya is a shop. Close at 22:00.", customer), "Saraya is a shop. Close at 22:00.");
	assert.equal(cleanCustomerText("SARA likes tea.", customer), "[removed] likes tea.", "The case does not matter.");
});

test("M13: the cleaning function removes an Arabic name and an address that is an email", () => {
	const arabic = { names: ["أحمد"], addresses: ["ahmad@example.com"] };
	assert.equal(cleanCustomerText("أحمد يحب القهوة. ahmad@example.com", arabic), "[removed] يحب القهوة. [removed]");
});
