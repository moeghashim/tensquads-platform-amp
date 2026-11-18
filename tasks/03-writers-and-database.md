# Task 03: the two writers and the database

Read first: `docs/ARCHITECTURE.md`, sections 3.3, 4.6, 6, 7.1 to 7.3, 8 and 10.2. PRD requirements P1 to P6, W1 to W4, V1 to V4 and O1 to O3. The report of task 01. Plan: https://tensquads-plan.pages.dev/#where-each-part-runs, #where-the-state-is.

## Goal

Petra and the Platform object as the two writers, a database with isolated accounts, the interface of the Worker, and the setup for a developer and for CI.

## Build

1. `packages/contracts`: zod 4 schemas for the commands to Petra, the admin commands, the six types of message to the owner (O1, O2), and each call and answer of the Worker interface (W1).
2. `db/`: numbered migrations for the tables of ARCHITECTURE section 7.2. Each table has its natural key. Tables that a later task fills are made here with their keys and their row-level security.
3. The three database roles of ARCHITECTURE section 3.3, with their grants. Row-level security on each account table, with no FORCE ROW LEVEL SECURITY. The views are owned by a role that row-level security does not limit.
4. `packages/adapters-postgres` and `packages/adapters-neon`: the two adapters of the database port, with the driver that the report of task 01 names. Each write is one short transaction that names the account.
5. `packages/petra`, the Platform object: one Durable Object with the fixed name `platform`. It handles `CreateAccount` and `AddOwner`, with `admin_commands` as its first write and a status, received then done (P4, P5). At its start, the Platform object runs each "received" command again. `CreateAccount` with `initialCredits` sends `GrantCredits` to the Petra of the account, and Petra writes the grant row. The other two admin commands come in task 10.
6. `packages/petra`, Petra: one Durable Object for each account. It writes each command to `events`, answers "accepted", and handles its work list one command at a time (P1, P4). If it stops in the middle of a command, it runs the command again.
7. The account writer and the platform writer, with one typed method for each write. The test P2: a script that fails when a package other than `petra` calls a write. The test P6: each method runs two times, and the tables are the same.
8. The identity test adapter, with two owners and one super admin. Petra reads `owners` to check that the identity reference belongs to her account.
9. Messages to the owner: `seq` from the counter of Petra, the list after a number, and the stream on a WebSocket with hibernation (W3). In this task, Petra answers each `OwnerMessage` with a fixed `reply`, so that the path has a message to send.
10. The interface of the Platform Worker, as in ARCHITECTURE section 6.5: the commands, the list and the stream, the status of a task, the admin commands, and one form for each error (W1, W2, W4). The gateway, the launcher calls and the views come in later tasks.
11. The setup (V1 to V3): the local emulator, a local Postgres, the Postgres service in CI. Write the steps in `README.md`.
12. A separate CI job that runs the contract tests of the Neon adapter against a Neon branch (V4). It runs on demand and each night, not on each pull request.

## Done

- One test for each of P1 to P6, W1 to W4, V1 to V3 and O1 to O3, with the id in the test name. All pass in CI. The test of V4 passes in its own job, and the pull request has its output.
- The isolation test P3 uses a real Postgres with row-level security and the three roles, not a mock. It proves that the role of Petra gets zero rows of a second account, and that the role of the Platform object cannot read an account table.
- The tests of the Durable Objects run inside the Workers runtime.
- A test stops Petra after the first write of a command. After a restart, the command is complete, and each table has each row one time.
- A test runs one command two times with a different answer of the fake model the second time. The tables have one task, one reply and one `seq` for each message.
- A test stops the Platform object after the `accounts` row and before `GrantCredits`. After a restart, the account has its credits one time.
- The pull request lists the migrations and the command that runs them.
- The recording shows: an account made with an admin command, an owner message sent, and the reply on the stream and in the list.

## Stop and ask

- If Moe has not given a Neon project for the job of V4.
- If a table of section 7.2 needs a key that the section does not give.
