import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

// The tools of the test bot that run in the sandbox. They use no network.
// The files of a task are in the work directory that the loop gives. An error goes to the model as the result.

export type BotTool = (input: Record<string, unknown>, workDir: string) => Promise<string>;

// The files that the tool read_file can read. They are part of the bot, so a test knows each answer.
export const TEST_FILES: Readonly<Record<string, string>> = {
	"shop/hours.txt": "The shop opens at 9:00 and closes at 17:00, from Monday to Saturday.",
	"shop/prices.txt": "A small box costs 12 dollars. A large box costs 20 dollars.",
};

function textField(tool: string, input: Record<string, unknown>, name: string): string {
	const value = input[name];
	if (typeof value !== "string") {
		throw new Error(`The tool ${tool} needs the text field "${name}".`);
	}
	return value;
}

// The full path of a file of the work directory. A path out of the directory is an error.
function workFile(workDir: string, path: string): string {
	const full = resolve(workDir, path);
	const rel = relative(resolve(workDir), full);
	if (rel === "" || rel.split(/[\\/]/)[0] === ".." || isAbsolute(rel)) {
		throw new Error(`The path "${path}" is not inside the work directory.`);
	}
	return full;
}

// Reads a file of the bot, or a file of the work directory of the task.
export const readFile: BotTool = async (input, workDir) => {
	const path = textField("read_file", input, "path");
	const content = TEST_FILES[path];
	if (content !== undefined) {
		return content;
	}
	const full = workFile(workDir, path);
	if (!existsSync(full)) {
		throw new Error(`No file has the path "${path}". The files are: ${Object.keys(TEST_FILES).join(", ")}.`);
	}
	return readFileSync(full, "utf8");
};

// The input is { path, text }. It adds the text at the end of a file of the work directory.
export const appendFile: BotTool = async (input, workDir) => {
	const path = textField("append_file", input, "path");
	const text = textField("append_file", input, "text");
	if (Object.hasOwn(TEST_FILES, path)) {
		throw new Error(`The file "${path}" is a file of the bot. It cannot change.`);
	}
	const full = workFile(workDir, path);
	mkdirSync(dirname(full), { recursive: true });
	appendFileSync(full, text);
	return `Added ${text.length} characters to "${path}".`;
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
