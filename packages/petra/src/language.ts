// The language of an answer of Petra (requirement N9). Our code selects it. The model gets it as an instruction.
export type Language = "en" | "ar";

const ARABIC_LETTER = /(?=\p{L})\p{Script=Arabic}/gu;
const LATIN_LETTER = /(?=\p{L})\p{Script=Latin}/gu;

const count = (text: string, letters: RegExp) => text.match(letters)?.length ?? 0;

// Arabic when the message has Arabic letters, and not fewer than its Latin letters. English when it has more Latin
// letters. In all other cases, for example a message with only numbers, the language of the account.
export function answerLanguage(text: string, accountLanguage: Language): Language {
	const arabic = count(text, ARABIC_LETTER);
	const latin = count(text, LATIN_LETTER);
	if (arabic > 0 && arabic >= latin) return "ar";
	if (latin > arabic) return "en";
	return accountLanguage;
}

const INSTRUCTIONS: Record<Language, string> = {
	en: "Write your answer to the owner in English.",
	ar: "Write your answer to the owner in Arabic.",
};

export const languageInstruction = (language: Language): string => INSTRUCTIONS[language];
