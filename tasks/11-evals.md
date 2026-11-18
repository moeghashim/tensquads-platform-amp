# Task 11: the base for evals

Read first: `docs/ARCHITECTURE.md`, sections 4.8 and 7.7. PRD requirements E1 to E6, decisions D23 and D26. Plan: https://tensquads-plan.pages.dev/#evals, #12-test-cases, #trails.

## Goal

The team can measure a bot or a decider on a set of cases, and compare two versions. The real bots come later, so this task proves the base with the test bot.

## Build

1. The case format (E1), as a zod schema in `packages/contracts`. Cases are files in `evals/cases/`.
2. `packages/evals` and `apps/evals`: the runner of evals (E2). It makes a test account from the setup of the case, plays the case through Petra, the launcher and the runner of the bot, and applies the grader.
3. The "no outgoing action" mode: the channel and payment ports only record what they would send.
4. Three graders: code, the checker model port, and "a person", which writes the case to a list for review and counts it as not decided.
5. The comparison of two versions (E3). A version is the three plug-in lists with their settings.
6. The function that makes a case from the trail of a task (E4). It works only while the trail exists. It removes each name, address and number of a customer, and it refuses a trail that it cannot clean.
7. The eval of the decider (E5), with a small set of messages that have a correct answer.
8. The report has, for each version: the pass rate, the variation, the cost and the time (decision D26).
9. Write five cases for the test bot from the plan, Part 12: P2, D3, K3, S4 and R18.

## Done

- One test for each of E1 to E6, with the id in the test name. All pass in CI.
- `npm run evals` runs the five cases three times each and prints the report.
- A test changes one script of the fake model so that one case fails. The comparison report names that case.
- The test of E4 makes a case from a trail with a name, a phone number and an email address of a customer. The case has none of them. A second test asks for a case from a trail that was deleted, and gets a clear refusal.
- A test proves that the runner of a bot has no path to the folder of the cases.
- The recording shows `npm run evals` and its report.

## Not in this task

Real models. The evals of the real bots. A gate that blocks a release.

## Stop and ask

If a grader needs a rule that the plan does not give.
