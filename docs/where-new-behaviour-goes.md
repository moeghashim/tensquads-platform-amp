---
summary: "Where new behaviour goes: the place for the code of each kind of change, and the boundary rules C2, C3 and C4"
read_when:
  - Adding a port, an adapter, a plug-in, a hook listener, a schema, a bot or a migration.
  - Deciding which package gets a new piece of code.
  - A boundary check (C2, C3 or C4) fails in `npm run check`.
---

# Where new behaviour goes

This page tells you where to put the code of each kind of change. It follows `docs/ARCHITECTURE.md`, section 3.2, and `docs/PRD.md`, section 7. If a change is not in this table, stop and ask Moe.

| Kind of change | Place for its code |
|---|---|
| A new port | `packages/core`: the TypeScript interface and its typed key. Add its contract tests in the same package |
| A new adapter for a port, for tests | `packages/adapters-test`. The adapter must pass the contract tests of its port |
| A new real adapter for a port | The `adapters-*` package of its kind: `adapters-postgres`, `adapters-neon`, `adapters-cloudflare` or `adapters-model`. The adapter must pass the same contract tests as the test adapter |
| A new plug-in | A new package `packages/<area>`, and one row in each plug-in list that needs it. The plug-in declares what it provides and what it needs |
| A new hook listener | The plug-in that owns the work, for example `credits`, `trail` or `memory`. The hook points are in `packages/core`. The loop calls them from `packages/loop` |
| A new rule of the gate, or a new limit of the owner | `packages/gate` |
| A new check of a result | `packages/checker` |
| A new kind of cost | `packages/costs` |
| A new decision point | The list of decision points in `packages/decisions` |
| A new bot, or a change to a bot definition | `packages/bots`, as data that passes its schema in `packages/contracts`. The tools and the instructions of the test bot are in `packages/bot-test` |
| A new schema: a command, an event, a message to the owner, a gateway call | `packages/contracts`, as a zod 4 schema. No code that runs |
| A write to an account table | A method of the account writer in `packages/petra`. Other plug-ins call the writer. They never get the database port |
| A write to a table with no account | A method of the platform writer in `packages/petra` |
| A migration | `db/`, as a new numbered file. Never edit a migration after it is merged |
| A new runtime part | A new folder in `apps/` |
| A plug-in list row | The list file of the runtime part: `apps/platform/src/plugins/petra.ts` (Petra), `apps/platform/src/plugins/platform.ts` (the Platform object) or `apps/runner/src/plugins.ts` (the runner) |

## The boundary rules

The script `scripts/check-boundaries.mjs` reads each source file in `apps/` and `packages/`. It checks three rules:

- **C2.** No plug-in imports another plug-in. The shared packages `core`, `contracts` and `bots` are not plug-ins. A plug-in can import them and its own files. A relative import must not leave the package. An app composes plug-ins, so an app can import them.
- **C3.** Only `packages/core` imports cordis.
- **C4.** No business package imports a database library or an SDK of an outside service. The business packages are all packages except `core` and the `adapters-*` packages. The script has the list of forbidden modules.

`npm run check` runs the script. To run it alone, use `node scripts/check-boundaries.mjs`. Each violation is one line: `C<n>: <file>: <message>`. The tests are in `scripts/test/boundaries.test.mjs`.
