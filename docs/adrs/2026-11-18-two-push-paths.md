---
summary: "Push through the no-mistakes gate when it is installed, and run the four checks and open a normal pull request when it is not"
read_when:
  - Pushing a branch of a PRD 1 task.
  - Working in a session that has no no-mistakes gate, such as an Amp orb.
---

# Two Push Paths

## Status

Accepted. It adds a second path to `2026-07-05-push-time-validation-via-no-mistakes-gate.md`. That decision stays the first path.

## Context

PRD 1, decision D14, says that the building agent works on the computer of Moe and pushes through the no-mistakes gate. The work can also run in a session where the gate program is not installed, for example an Amp orb or a cloud session. PRD 1, section 10, gives the path for that case.

## Decision

There are two push paths:

1. **The gate is installed.** Run `no-mistakes init` one time. Push each branch with `git push no-mistakes`, never to `origin` directly. The gate tests the branch and opens the pull request.
2. **The gate is not installed.** Before each push, run `npm ci && npm test`, `npm run check`, `npm run agent:check` and `npm run fallow:audit`. Put the output in the pull request. Then push the branch to `origin` and open a normal pull request.

In both paths, CI on the pull request is the merge backstop, and Moe approves each pull request.

## Consequences

- An agent in a session with no gate can push. It must show the output of the four commands in the pull request.
- The second path has no automatic review and no automatic fixes. The reviewer must read the output of the four commands.

## Alternatives Considered

- Install the gate in each session: not always possible. The gate needs a daemon and a sign-in on the machine.
- Block the work until the gate is installed: this stops each session that is not on the computer of Moe.
