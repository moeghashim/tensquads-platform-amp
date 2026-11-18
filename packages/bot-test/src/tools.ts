// The tools of the test bot that run in the sandbox. Each one is a pure function: it reads no disk and no network.
// An error goes to the model as the result of the tool.

export type BotTool = (input: Record<string, unknown>) => Promise<string>;

// The files that the tool read_file can read. They are part of the bot, so a test knows each answer.
export const TEST_FILES: Readonly<Record<string, string>> = {
	"shop/hours.txt": "The shop opens at 9:00 and closes at 17:00, from Monday to Saturday.",
	"shop/prices.txt": "A small box costs 12 dollars. A large box costs 20 dollars.",
};

export const readFile: BotTool = async (input) => {
	const path = input.path;
	if (typeof path !== "string") {
		throw new Error('The tool read_file needs the text field "path".');
	}
	const content = TEST_FILES[path];
	if (content === undefined) {
		throw new Error(`No file has the path "${path}". The files are: ${Object.keys(TEST_FILES).join(", ")}.`);
	}
	return content;
};

const OPERATIONS = {
	add: (a: number, b: number) => a + b,
	subtract: (a: number, b: number) => a - b,
	multiply: (a: number, b: number) => a * b,
	divide: (a: number, b: number) => a / b,
} as const;

function isOperation(value: unknown): value is keyof typeof OPERATIONS {
	return typeof value === "string" && Object.hasOwn(OPERATIONS, value);
}

// The input is { op, a, b }. The op is add, subtract, multiply or divide.
export const calculate: BotTool = async (input) => {
	const { op, a, b } = input;
	if (!isOperation(op)) {
		throw new Error(`The tool calculate needs "op": one of ${Object.keys(OPERATIONS).join(", ")}.`);
	}
	if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) {
		throw new Error('The tool calculate needs the numbers "a" and "b".');
	}
	if (op === "divide" && b === 0) {
		throw new Error("The tool calculate cannot divide by zero.");
	}
	return String(OPERATIONS[op](a, b));
};
