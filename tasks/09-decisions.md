# Task 09: decisions

Read first: `docs/ARCHITECTURE.md`, sections 4.6 and 4.7. PRD requirements Q1 to Q8, decisions D18, D19 and D25. Plan: https://tensquads-plan.pages.dev/#how-petra-decides, #fast-decision-model-jev, #decisions-jev.

## Goal

Each small decision of the system has a name, a record and a level. A second decider can be compared with the first one on the same questions.

## Build

1. `packages/decisions`: the list of decision points (Q1). Start with these points, from the plan: "which bot", "is the request clear", "is this a refund request", "is the reason in the rule", "is the message safe to send", "is this message for a task that runs".
2. The decider port with several questions in one call (Q2). Each question has a type: yes or no, choice, score. Make the types fit Jev (decision D25): read the notes for builders in the plan, https://tensquads-plan.pages.dev/#decisions-jev. Do not write the Jev adapter.
3. Two decider adapters: one that asks the model port, and one test adapter with fixed answers and probabilities.
4. The decision record (Q3) and the outcome record (Q6), written through the account writer.
5. The level of each decision point, and the path below the level (Q4). The first value of each level is 0.90 for a yes or no question and for a choice. Put the values in one file. Moe confirms them in the pull request.
6. The shadow mode (Q5): a setting names a second decider. Its answers are recorded and never used.
7. Connect the decision sequence of Petra and the gate to the decision points. Our code applies the rule of the owner (Q7).

## Done

- One test for each of Q1 to Q8, with the id in the test name. All pass in CI.
- The plan example passes with test adapters: "My eggs arrived broken. I want my $15 back." with a limit of $20. Three answers above the level give a refund with no approval. One answer below the level gives an approval request. $60 always gives an approval request.
- A test runs a second decider in shadow mode and proves that a different answer from it changes nothing in the task.
- The test of Q4 has four cases: below the level, an answer that is not one of the options, an error, and a timeout.
- The recording shows the plan example and its decision records.

## Not in this task

A call to the real Jev. A real model.

## Stop and ask

For each decision point that is not in the list above. Do not add a point without Moe.
