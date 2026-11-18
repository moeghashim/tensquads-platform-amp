# Task 05: the gate

Read first: `docs/ARCHITECTURE.md`, sections 3.5, 4.3, 4.4, 7.2 and 9. PRD requirements G1 to G12, decisions D8 and D9. Plan: https://tensquads-plan.pages.dev/#6-how-a-bot-does-a-task, #the-loop-in-detail (the parts "Work in progress" and "One action, one time"), #how-petra-decides.

## Goal

An action goes out only through the gate, with the rule of the owner, and not two times.

## Build

1. `packages/gate` and the gateway call `action`. An action tool is one call to `action`. It never calls a service from the sandbox (G1). Each action tool is declared `replay: "safe"`, and its `execute()` calls `journal`, then `action` (G5). The kind of each action comes from the definition of the bot.
2. The rules and the limits of the owner, with the `SetRule` command (G2, G3).
3. Approvals: the `approval_request` message, the `ApprovalDecision` command, and the check that the hash of the decision equals the hash of the action (G4). When `action` answers "wait for the owner", the action tool parks on a signal with the id of the action. A new attempt delivers the decision as a signal, and the tool calls `action` again with the same id. A rejected approval gives the status "rejected" and a refusal to the model (G10).
4. The id of an action: the task id and the id of the tool call (G5).
5. The status sequence of ARCHITECTURE section 4.4, with "started" before the service call and "done" after it (G6).
6. An id that comes again: "done" gives the saved answer (G7), a different content is refused with a trail row (G8), "started" asks the service (G9).
7. The check of an action that stays "started": a job that Petra puts in the "jobs" queue when the gate writes "started". It takes only an action that is "started" for longer than the time limit of a tool, and it changes the status only if the status is still "started". If the service cannot answer, the status is "not confirmed", and Petra sends `action_not_confirmed`.
8. The channel and payment test adapters: each one records a send, and can answer "confirmed", "not sent" or "unknown".
9. The draft store and the gateway call `draft` (G11). Each save has its attempt and call number, and `start` gives the files that belong to the journal copy.

## Done

- One test for each of G1 to G12, with the id in the test name. All pass in CI.
- The test of G12 runs the full path with a real runner process, and kills the runner at each of the four points. After each kill, the payment adapter has one send, and the model did not ask for the action a second time.
- A test of G8 uses a script of the fake model that asks for $40 in the first attempt and for $45 with the same tool-call id in the second attempt. The gate refuses, and no second send goes out.
- A test of G9 sends a copy of an `action` call while the payment adapter still waits. The copy gets "busy, try again", the action gets "done", and it never gets "not confirmed".
- A second test of G9 lets a new attempt call `action` while the call of the old attempt still runs in Petra. The new call gets "busy, try again".
- A test stops Petra after she wrote a "pending" action and before the approval request. When the action comes again, the owner gets the request one time.
- A test of G11 appends to a file after the last copy of the journal, and kills the runner. The new attempt gets the file as it was at the copy, and the append is there one time at the end.
- A test sends an `ApprovalDecision` for a task that was cancelled. No action goes out, and the owner gets a `status` message.
- A test proves that the runner has no code path to the channel or payment port.
- The recording shows a refund above the limit: the approval request, the approval, and one send.

## Not in this task

A real channel. A real payment. The decision points: in this task, the gate reads the amount and the kind from the request, with no decider. Task 09 connects the decider.

## Stop and ask

If a rule of the owner in the plan has a form that `SetRule` cannot hold.
