// The cleaning of a text of a customer (docs/ARCHITECTURE.md, section 7.8, requirement M13).
// The night job uses it for a fact or a core item that the owner approved or promoted. The evals reuse it.
import { regularText } from "./regular.js";

// The data of one customer: the names from the payloads of the events, and the addresses on the channels.
export interface CustomerData {
	names: readonly string[];
	addresses: readonly string[];
}

export const REMOVED = "[removed]";

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
// A number like a phone number: digits with spaces, dashes, dots or brackets, and 7 digits or more.
const PHONE = /\+?\(?\d[\d\s().-]{5,}\d/g;
const PHONE_DIGITS = 7;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A whole word or words: no letter or digit just before or after it. \b does not work for Arabic.
function wholeWords(text: string): RegExp {
	return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(text)}(?![\\p{L}\\p{N}])`, "giu");
}

// The full names first, then each part of a name, the longest first.
function namePatterns(names: readonly string[]): string[] {
	const parts = names.flatMap((name) => name.split(/\s+/));
	return [...new Set([...names, ...parts].map((part) => part.trim()).filter((part) => part.length > 1))].sort(
		(a, b) => b.length - a.length,
	);
}

// Removes the names, the addresses, the email addresses and the phone numbers of the customer from a text.
export function cleanCustomerText(text: string, customer: CustomerData): string {
	let clean = text.replace(EMAIL, REMOVED);
	for (const address of customer.addresses.filter((item) => item.trim() !== "")) {
		clean = clean.replace(new RegExp(escapeRegExp(address), "gi"), REMOVED);
	}
	clean = clean.replace(PHONE, (found) => (found.replace(/\D/g, "").length >= PHONE_DIGITS ? REMOVED : found));
	for (const name of namePatterns(customer.names)) clean = clean.replace(wholeWords(name), REMOVED);
	return clean;
}

// The cleaned text of a fact, with the regular text for its search column (requirement M12).
export function cleanedFact(text: string, customer: CustomerData): { text: string; search: string } {
	const clean = cleanCustomerText(text, customer);
	return { text: clean, search: regularText(clean) };
}
