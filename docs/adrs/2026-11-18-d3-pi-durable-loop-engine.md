---
summary: "D3: pi-durable is the engine of the loop, pinned to one exact version, as one plug-in behind a port"
read_when:
  - Working on the loop of a bot or the loop of Petra.
  - Changing the version of pi-durable or the journal of a task.
---

# D3: pi-durable Is The Engine Of The Loop

## Status

Accepted. PRD 1, decision D3.

## Context

The loop of a bot must survive a stop of its sandbox. The loop of Petra must survive a restart of her Durable Object. Both loops need a journal of each step, a resume, hooks around each model request and each tool, and a way for a tool to park on a signal.

## Decision

The engine of the loop is pi-durable (`@earendil-works/pi-durable`), pinned to one exact version. It runs as one plug-in behind the port "run a task". Only `packages/loop` imports pi-durable.

## Consequences

- The runner keeps the journal in a local SQLite file, and sends a copy to the gateway after each turn and before each action (`docs/ARCHITECTURE.md`, section 4.3).
- Petra uses the pi-durable storage for Durable Objects.
- Task 01 must prove the hooks, the resume from a copy, the stable tool-call id, `replay: "safe"`, the park on a signal, and the drop of a message with a known request id.

## Alternatives Considered

- A loop of our own: we would have to build the journal, the resume and the replay rules.
- A storage that sends each commit to the gateway: this is the second design if copies of the journal are too slow or too large. Stop and ask before it is built.
