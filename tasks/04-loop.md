# Task 04: the loop

Read first: `docs/ARCHITECTURE.md`, sections 3.4 to 3.6, 4.1 to 4.3, 4.6, 5, 7.3 and 9. PRD requirements L1 to L15, decisions D4, D5, D17, D28 and D29. The report of task 01. Plan: https://tensquads-plan.pages.dev/#in-simple-words-bot-image-sandbox-and-state, #inside-a-bot, #how-petra-and-a-bot-speak-during-a-task, #the-loop-in-detail, #the-engine-of-the-loop-pi-durable.

## Goal

Petra starts a task of the test bot. A launcher starts a runner. The runner does the task through the gateway, in one attempt or more.

## Build

1. `packages/loop`: the pi-durable harness and the eight hook points of ARCHITECTURE section 4.1. The only package that imports pi-durable.
2. The loop of Petra in her Durable Object, with the storage of pi-durable for Durable Objects, and one alarm handler for pi-durable and the work list. Her tools: start a task, answer the owner, ask the owner, read the memory, tell the status of a task, stop a task. Each tool is declared `replay: "safe"`. The fake model selects the tool. One command starts one task or none, the task id is the command id, and "start a task" writes its four steps in the sequence of ARCHITECTURE section 4.6 (decision D33).
3. The brief with six parts (L1), and the result with its stop name (L2).
4. Attempts (decision D28): the `attempts` rows, the pass with its attempt number, and the two checks of the pass, by the Worker and by Petra (L9).
5. `packages/gateway`: the calls `start`, `model`, `step`, `inbox`, `journal` and `result`, each with a call number, a runner id, the mark "in progress" and a saved answer for each call number. `journal` writes one `journal_copies` row, and `start` gives the copy with the largest numbers. The calls `action` and `draft` come in task 05.
6. The sandbox port with its test adapter, the list in the Platform object, the two launcher calls of the Worker, and `apps/launcher` (L12).
7. `apps/runner` with `packages/link` and `packages/bot-test`. The runner has no key and no database port. Each model call goes through the gateway (L10).
8. Messages to a task that runs: the inbox, taken between two turns (L3). `inbox` returns all the messages of the task, and the runner gives each one to the loop with its source reference as the request id.
9. The limit of turns of a task type, from the definition of the bot (L4, L13).
10. A sandbox that stops: the report of the launcher, the "check task" job that Petra puts in the "jobs" queue when she writes an attempt, one new attempt for each task, then "failed" (L5). An attempt has a `cause_ref`, so a report that comes two times adds one attempt. Petra ignores a report for an old attempt or for a task that is not running. Map the run failures `interrupted` and `restart_limit` of pi-durable to the stop name `error`.
11. A task that waits for the owner with the stop name `question`: the tool "ask a question" parks on a signal, the runner exits, and a new attempt delivers the answer as a signal after `OwnerAnswer` (L6).
12. The status of a task from its trail rows (L7), and the versions of each attempt (L11).
13. The recovery of Petra when her Durable Object loses its storage (L14).

## Test doubles in this task

Each double is one row in a plug-in list. A later task replaces the row.

| Part | Double in this task | Replaced in |
|---|---|---|
| Trail | A small plug-in that writes trail rows with the final key and columns | Task 07 |
| Credits | A plug-in that always says "sufficient" | Task 07 |
| Checker | A plug-in that always says "stands" | Task 06 |
| Costs, and the limit of budget | No cost row. The stop name `max_budget` has a unit test only | Task 10 |
| Provider and model in the versions | The name of the fake model | Task 12 |

## Done

- One test for each of L1 to L15, with the id in the test name. All pass in CI.
- The tests of L5, L6, L9 and L12 run the full path on one machine: the local emulator, the launcher and a real runner process.
- The test of L5 kills the runner during a turn. The trail has the rows of both attempts, each with its attempt number, and no row is there two times.
- The test of L9 has four cases: a pass of a different task, a pass of an old attempt, a pass of a task that ended, and a pass after its end time.
- The test of L12 starts two runners with the pass of one attempt. The second `start` is refused.
- The test of L3 kills the runner after `inbox` and before the next copy of the journal. The model of the new attempt gets the message one time.
- A test of L5 lets the runner exit on purpose after "wait for the owner", and sends the exit report two times. No new attempt starts.
- A test saves 12 copies of the journal in one attempt. `start` gives copy 12, not copy 9.
- A test stops Petra at each of the four steps of "start a task", and one time takes away her storage. Each time, the result is one task, one charge, one attempt and one request for a sandbox.
- A test stops the launcher after it took a request. The task gets a new attempt, and this does not count as its one failure.
- The test of L15 has three cases: the owner writes "stop" with one open task, and the task is cancelled; with two open tasks, Petra asks which one; a `CancelTask` command and the tool give the same rows.
- The test of L8 replaces the model, one tool and the checker, each with one changed row.
- The recording shows a task of the test bot from the owner message to the result, with a kill of the runner in the middle.

## Not in this task

Actions, approvals and drafts. The real check of a result. Credits and costs. Forget.

## Stop and ask

- If the report of task 01 says that copies of the journal are not sufficient.
- If pi-durable cannot share the alarm of the Durable Object.
- If the report of task 01 says that a tool cannot park and continue in a new process with the same id.
