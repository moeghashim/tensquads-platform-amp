// The regular text of the search (docs/ARCHITECTURE.md, section 7.1, requirement M12).
// Our code makes each text regular before it writes a search column and before it searches.
// The search column uses the "simple" configuration of Postgres on this text.

// The forms of alef: with hamza above, with hamza below, with madda, and wasla.
const ALEF_FORMS = /[\u0623\u0625\u0622\u0671]/g;
// The diacritics (tashkeel) and the superscript alef.
const DIACRITICS = /[\u064B-\u0652\u0670]/g;
const TATWEEL = /\u0640/g;
// A word is a sequence of letters and digits. No word has an operator of a text search query.
const WORD = /[\p{L}\p{N}]+/gu;

export function regularText(text: string): string {
	return text.replace(ALEF_FORMS, "\u0627").replace(DIACRITICS, "").replace(TATWEEL, "").toLowerCase();
}

// The query of a search for "to_tsquery('simple', ...)": each word of the regular text one time, joined with "or".
// An empty text gives an empty query, and the search finds nothing.
export function searchQuery(text: string): string {
	const words = new Set(regularText(text).match(WORD) ?? []);
	return [...words].join(" | ");
}
