---
summary: "D7: the database is one Neon Postgres database, with row-level security and three database roles as the second safety layer"
read_when:
  - Adding a migration, a table or a database role.
  - Working on the isolation of accounts.
---

# D7: Neon With Row-Level Security

## Status

Accepted. PRD 1, decision D7.

## Context

The record of each account must be in one place, and one account must never see the rows of a different account. The Durable Object of Petra is the first barrier. The database must be a second barrier.

## Decision

- The database is Neon (Postgres). There is one database for all accounts.
- Each table of an account has `account_id` and row-level security.
- There are three database roles: `ts_petra`, `ts_platform` and `ts_admin_views` (`docs/ARCHITECTURE.md`, section 3.3). The migrations run with the owner role, and no runtime part has it.
- A developer and CI use a plain Postgres. The database port has two adapters, `adapters-postgres` and `adapters-neon`, and both pass the same contract tests.

## Consequences

- Requirement P3 has a test with two accounts against a real Postgres.
- Task 01 must name one database driver that works from a Durable Object to a plain Postgres and to Neon.

## Alternatives Considered

- One database for each account: more resources, and harder views for the team.
- The Durable Object SQLite as the record: the views for the team would need data from each object.
