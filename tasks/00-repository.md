# Task 00: the repository

Read first: `docs/PRD.md` in full. `docs/ARCHITECTURE.md` in full. Then `AGENTS.md`, `README.md` and `docs/agent-workflow.md` of the starter.

## Goal

Put the starter `moeghashim/pi-starter` into `moeghashim/tensquads-platform-amp`, and make it ready for the platform tasks.

## Build

1. Copy the starter at its newest commit on `main`. Keep `progress.md` and add one entry that says where the fork started.
2. The repository uses Node 26 (decision D27). If the starter is still on Node 24 when you copy it, change `.nvmrc`, each `engines` field, `@types/node` and the Node version in CI to 26, and say so in the pull request.
3. Rename the package scope from `@pi-starter` to `@tensquads`. Do not use the name `@tensquads/ui`.
4. Keep `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/LATER.md` and the `tasks/` folder, which are already in the repository.
5. Add to `AGENTS.md`, in the style of the file:
   - The read order: `AGENTS.md`, `docs/PRD.md`, `docs/ARCHITECTURE.md`, the task file, the plan sections that the task names, the last twenty lines of `progress.md`.
   - The receipt before any code (PRD section 10).
   - Simplified Technical English for comments, commits, pull requests and questions.
   - A clear expectation and a recording in each pull request, in `docs/evidence/<task>/` (PRD section 10).
   - "Stop and ask" for a behaviour that the plan, the PRD and the architecture document do not give.
   - The two push paths of PRD section 10.
6. Write one ADR for the two push paths, and one for each of the decisions D2, D3, D4, D5, D6, D7, D8 and D28.
7. Add three empty programs, each with its build in CI: the `apps/platform` Worker with its own `wrangler.jsonc`, `apps/runner` and `apps/launcher`.

## Done

- `npm run check`, `npm test`, `npm run agent:check` and `npm run fallow:audit` return 0.
- CI is green on the pull request, on Node 26.
- The pull request lists each file that differs from the starter, with one line of reason.
- The recording shows the four commands on a new clone.

## Not in this task

No cordis, no pi-durable, no database.
