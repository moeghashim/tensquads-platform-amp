---
summary: "D6: only two writers write the database, Petra for the data of her account and the Platform object for the data that has no account"
read_when:
  - Adding a write to the database.
  - Adding a table or changing the database port.
---

# D6: Two Writers

## Status

Accepted. PRD 1, decision D6.

## Context

Each write must be in one place, so that the rules of an account are applied one time and in sequence. Some data has no account: accounts, owners, unit prices, shared costs and admin commands.

## Decision

- There are two writers, and both are in the `petra` package.
- Petra, one Durable Object for each account, writes the tables of her account.
- The Platform object, one Durable Object with the fixed name `platform`, writes the tables that have no account.
- Each other part sends a command to a writer. It never gets the database port.

## Consequences

- Requirement P2 has a test that fails when a package other than `petra` calls a write.
- Each write is one short transaction with a natural key, so it can run two times with the same result (requirement P6).
- The runner, the launcher and the Platform Worker have no database port.

## Alternatives Considered

- One writer for all data: the data with no account would need an account, or a writer that can see all accounts.
- A writer in each package: the rules of an account would be in many places.
