---
summary: "D8: the id of an action is the task id and the tool-call id, and the gate never does the same id two times"
read_when:
  - Working on the gate, an action tool or the journal of a task.
  - Changing the rules for an action that comes again.
---

# D8: One Id For Each Action

## Status

Accepted. PRD 1, decision D8.

## Context

A sandbox can stop at any point. A turn can then run again in a new attempt. An action with money or a public action must not go out two times.

## Decision

- The id of an action is the task id and the id of its tool call in the journal.
- The runner saves a copy of the journal before it asks the gate for an action.
- An action tool is declared `replay: "safe"`, so it runs again after a stop with the same id.
- An action that waits for the owner parks on a signal, and continues with the same id.
- The gate does not do the same id two times. It refuses the same id with a different content.
- If a service cannot confirm an action, the gate does not repeat it, and Petra tells the owner.

## Consequences

- The promise is "not two times". It is not "exactly one time".
- Requirements G5 to G9 and G12 test this rule.
- Task 01 must prove that a tool-call id is stable after a resume and occurs one time in a task.

## Alternatives Considered

- The task id and the step number: a turn that runs again can give a different step number to a different action.
- A random id for each request: a request that runs again gets a new id, and the action can go out two times.
