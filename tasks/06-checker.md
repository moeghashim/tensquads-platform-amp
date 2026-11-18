# Task 06: the check of a result

Read first: `docs/ARCHITECTURE.md`, sections 3.5 and 4.1. PRD requirements K1 to K3. Plan: https://tensquads-plan.pages.dev/#how-a-result-is-checked.

## Goal

A result goes to the owner only after the check passes.

## Build

1. `packages/checker`: it replaces the double of task 04. The gateway call `result` runs the tests by code first, then the checker model (K1).
2. The tests by code of the test bot: the result has each part that the brief asked for, and each fact that it names has an id from the brief.
3. The checker model port, with its own row in the plug-in list of Petra. The test adapter passes or fails by rule (K2).
4. A failed check answers "continue" with the reason. The loop continues inside the limits of the task type (K3).

## Done

- One test for each of K1 to K3, with the id in the test name. All pass in CI.
- A test replaces the row of the checker model with a second adapter, with no change to the row of the model of the bot.
- A test with a script that gives a wrong result first and a correct result second: the owner gets only the second one.
- The recording shows that test.

## Not in this task

A real checker model. The check for a forgotten fact, which comes in task 08.
