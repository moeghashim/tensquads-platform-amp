---
summary: "D5: the hook points of the loop are cordis events called from the pi-durable hooks, and the rules run on Cloudflare behind one gateway"
read_when:
  - Adding or changing a hook point of the loop.
  - Adding or changing a call of the gateway.
---

# D5: Hook Points And One Gateway

## Status

Accepted. PRD 1, decision D5.

## Context

The gate, the check, the credits, the costs and the trail need the keys, the rules and the database. A sandbox has none of these (decision D17). The loop must still call them at fixed points of each turn.

## Decision

- The loop has hook points, and they are cordis events. The runner calls them from the pi-durable hooks `beforeRequest`, `beforeTool`, `afterTool`, `afterTools` and `onYield`.
- The gate, the check, the credits, the costs and the trail run on Cloudflare, in Petra, behind one gateway.
- The gateway has a fixed list of calls: `start`, `model`, `step`, `action`, `inbox`, `journal`, `draft` and `result` (`docs/ARCHITECTURE.md`, section 3.5).

## Consequences

- Most of the work of a hook in the runner is one call to the gateway.
- A plug-in that is removed takes its hooks with it (requirement C6).
- Task 01 must prove that a cordis event can be called from each pi-durable hook.

## Alternatives Considered

- The rules in the runner: the sandbox would need keys and database access.
- One gateway call for each rule: more calls, and more places for a fault.
