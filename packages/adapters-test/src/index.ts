// A test adapter for each port that PRD section 6 marks "Test". Each export gives one plug-in row.
export { type CheckRule, ruleChecker } from "./checker-model.js";
export { fixedDecider } from "./decider.js";
export { TEST_PRINCIPALS, TEST_TOKENS, testIdentity } from "./identity.js";
export { echoModel, type ScriptedAnswer, scriptedModel } from "./model.js";
export { ruleModel } from "./rule-model.js";
export { localSandbox } from "./sandbox.js";
export { testChannel, testPayment } from "./send.js";
