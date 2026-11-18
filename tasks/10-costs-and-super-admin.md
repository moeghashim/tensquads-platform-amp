# Task 10: costs and the super admin data

Read first: `docs/ARCHITECTURE.md`, sections 3.3, 6.2, 6.5, 7.1, 7.2 and 7.6. PRD requirements S1 to S9, decisions D20 to D22 and D28. Plan: https://tensquads-plan.pages.dev/#price-cost-and-the-super-admin-dashboard, #trails.

## Goal

The team can see what each account, task type, bot and model costs us, beside what the owner paid.

## Build

1. `packages/costs`: one cost row for each thing that we pay for (S1), from the gateway calls `model` and `step`, from the gate for an outside service, from the checker and from the decider. Each row has its attempt number and its source reference. A model call of Petra or of a decider in a command has the key `cmd/{commandId}/model/{providerRequestId}`.
2. The price list: the `SetUnitPrice` admin command and the `unit_prices` table (S2). A cost row keeps the price of its time.
3. A test that fails if costs and credits share a table, or if a table has a stored sum (S3).
4. Shared costs: the `SetSharedCost` admin command, the usage view, the division with whole numbers, the `shared_cost_parts` rows that are written before a share is sent, and the `AddCostShare` command to each Petra (S4). With no usage in the period, the parts are equal. The kinds are storage, database and worker.
5. A correction with `supersedes` (S5).
6. The views of the schema `admin` (S6, S7), with "a task that is stuck" as ARCHITECTURE section 7.6 defines it, and the call `GET /v1/admin/views/{name}`. A view returns no text of a message, a brief, a fact or an action.
7. The super admin role (S8): the four admin commands, the views, and the trail read that Petra records in `admin_reads`.
8. The limit of budget of a task type: the gateway adds the cost rows of the task before each model call (S9). This replaces the unit test of task 04.

## Done

- One test for each of S1 to S9, with the id in the test name. All pass in CI.
- The test of S1 has three cases: the same gateway call two times gives one row; a turn that runs again in a new attempt gives two rows; the cost view of the task has the sum of both.
- The test of S4 divides an amount that does not divide evenly between three accounts. The sum of the three rows equals the amount. A second test stops the Platform object after the first share, adds a cost row to one account, and runs the command again: the parts do not change. A third test has no usage, and the parts are equal.
- The test of S5 corrects an amount. No old row changed, and the view has the new amount.
- The test of S8 tries each admin call as an owner, and each owner call as a super admin. It also proves that the role of the views cannot read an account table.
- The recording shows the cost view of one account after two tasks.

## Not in this task

The screens of the super admin. Revenue for each account.

## Stop and ask

If a thing that we pay for has no kind in S1.
