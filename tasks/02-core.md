# Task 02: the plug-in core

Read first: `docs/ARCHITECTURE.md`, sections 3.1 to 3.3. PRD sections 5 to 8. Plan: https://tensquads-plan.pages.dev/#everything-is-a-plug-in-with-a-proof, #domain-driven-design-as-the-software-architecture, #the-anti-corruption-layer, #what-we-take-from-deepseek-harness.

## Goal

The cordis core, the ports and the plug-in lists. Requirements C1 to C6.

## Build

1. `packages/core`: the only package that imports cordis. It loads a plug-in list, checks the dependencies at the start, and removes plug-ins in reverse order.
2. The three plug-in lists: for Petra, for the Platform object, for the runner. Each one is one file, with one row for each plug-in. A plug-in declares what it provides and what it needs.
3. The ports as TypeScript interfaces with typed keys: database, object store, queue, model, checker model, sandbox, decider, identity, channel, payment.
4. `packages/contracts`: the schema of the definition of a bot (decision D29). `packages/bots`: the definition of the test bot, with one task type, its price, its limits, its tools and its read list.
5. `packages/adapters-test`: a test adapter for each port that PRD section 6 marks "Test".
6. Contract tests for each port. Each adapter runs the same tests.
7. The boundary tests C2, C3 and C4 as scripts that read the source files. Add them to `npm run check`.

## Done

- One test for each of C1 to C6, with the id in the test name. All pass in CI.
- A test replaces one test adapter with a second one, with no change to another package.
- `docs/` has one page, "Where new behaviour goes": one row for each kind of change and the place for its code.
- The recording shows the tests, and a start that fails with a clear message when a port is missing.

## Not in this task

No database, no loop.
