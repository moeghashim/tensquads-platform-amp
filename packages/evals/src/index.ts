// The base for evals (docs/ARCHITECTURE.md, section 4.8, requirements E1 to E5). It runs in Node, not in Petra.
export { type DeciderReport, type DeciderRun, deciderEval, formatDeciderReport } from "./decider-eval.js";
export {
	codeGrade,
	type Grade,
	type GradeDeps,
	gradeRun,
	type ReviewEntry,
	type RunRecord,
	type Verdict,
} from "./grade.js";
export {
	type Comparison,
	compareVersions,
	formatComparison,
	formatReport,
	type RunResult,
	type VersionReport,
	versionReport,
} from "./report.js";
export {
	type CustomerData,
	caseFromTrail,
	type TrailCaseInput,
	type TrailCaseOutcome,
	type TrailCaseRow,
} from "./trail-case.js";
