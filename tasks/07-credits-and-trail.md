# Task 07: credits and the trail

Read first: `docs/ARCHITECTURE.md`, sections 7.1, 7.2, 7.4, 7.6 and 7.7. PRD requirements T1 to T8, decisions D20, D28 and D32. Plan: https://tensquads-plan.pages.dev/#7-credits-and-prices, #trails.

## Goal

A task has one fixed price in credits. Each step of each task is one trail row.

## Build

1. `packages/credits`: it replaces the double of task 04. The credit check at `task/start` (T1). One "charge" row with the price of the task type, from the definition of the bot (T2). One "give back" row after a stop at a limit, after a cancel for a deletion, and after a cancel by the owner before a runner started (T3). The key of the charge row is `task/{taskId}/charge`. A "grant" row comes from `CreateAccount` with `initialCredits` (task 03), because the purchase of credits is out of scope.
2. The balance as a query (T4). A test fails if a table has a column for a sum.
3. `packages/trail`: it replaces the double of task 04. One row for each step, with the task, the attempt, the turn and the source reference (T5). No call of the gateway takes credits.
4. One query for the full trail of a task, in sequence, with each attempt (T6).
5. A large item goes to R2, and the row keeps a link and a hash (T7).
6. The deletion of a trail in the night job: one month after the task ended, with its items in R2, and never for an open task. A trail row with no task is deleted one month after it was written (T8). The night job gets its schedule in task 08. In this task, a test sends the `RunJob` command directly.

## Done

- One test for each of T1 to T8, with the id in the test name. All pass in CI.
- A test of T2 runs a task with two attempts and ten model calls. The ledger has one "charge" row.
- A test of T8 uses a clock that the test controls: a task that ended 32 days ago has no trail, and a task that waits for the owner for 40 days has its full trail.
- A test proves that a ledger row and a trail row cannot be changed or deleted by the role of Petra, except the deletion of T8. That deletion is a row-level rule: the task of the row ended more than one month ago.
- The recording shows the trail of one task and the balance before and after it.

## Not in this task

Prices and packages. Costs, which are a separate record (task 10).

## Stop and ask

If the plan gives a rule for credits that these requirements do not cover.
