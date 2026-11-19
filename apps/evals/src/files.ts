// The files of the evals in the repository: the cases, the versions and the labelled messages of the decider.
// They are outside the sandbox of a bot (requirement E6). Only this program reads them.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
	type DeciderItem,
	deciderItem,
	type EvalCase,
	type EvalVersion,
	evalCase,
	evalVersion,
} from "@tensquads/contracts";

export const EVALS_DIR = join(import.meta.dirname, "..", "..", "..", "evals");

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

// Each case in evals/cases, in the order of the ids that are given. With no ids, each case by its id.
export function loadCases(ids?: readonly string[]): EvalCase[] {
	const dir = join(EVALS_DIR, "cases");
	const all = readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => evalCase.parse(readJson(join(dir, name))))
		.sort((a, b) => a.id.localeCompare(b.id));
	if (!ids) return all;
	return ids.map((id) => {
		const found = all.find((item) => item.id === id);
		if (!found) throw new Error(`No case has the id ${id}.`);
		return found;
	});
}

export function loadVersions(names: readonly string[]): EvalVersion[] {
	return names.map((name) => {
		const path = join(EVALS_DIR, "versions", `${name}.json`);
		let raw: unknown;
		try {
			raw = readJson(path);
		} catch {
			throw new Error(`No version has the name ${name}.`);
		}
		const version = evalVersion.parse(raw);
		if (version.name !== name) throw new Error(`The file of the version ${name} has the name ${version.name}.`);
		return version;
	});
}

export function loadDeciderItems(): DeciderItem[] {
	const raw = readJson(join(EVALS_DIR, "decider", "messages.json"));
	return deciderItem.array().parse(raw);
}
