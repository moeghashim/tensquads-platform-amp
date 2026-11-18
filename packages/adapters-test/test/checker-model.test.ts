import { ports, startSystem } from "@tensquads/core";
import { checkerModelContract } from "@tensquads/core/contract-tests";

import { ruleChecker } from "../src/index.js";

checkerModelContract("checker-model-rule", async () => (await startSystem([ruleChecker()])).port(ports.checkerModel), {
	passing: { taskId: "task-1", goal: "Answer the customer.", result: "The order is ready." },
	failing: { taskId: "task-2", goal: "Answer the customer.", result: "  " },
});
