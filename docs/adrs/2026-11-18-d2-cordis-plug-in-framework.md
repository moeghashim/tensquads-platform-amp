---
summary: "D2: cordis is the plug-in framework, pinned to one exact version, and only packages/core imports it"
read_when:
  - Adding a plug-in, a port or a plug-in list.
  - Changing the version of cordis or a boundary test.
---

# D2: cordis Is The Plug-in Framework

## Status

Accepted. PRD 1, decision D2.

## Context

The plan says that everything is a plug-in with a proof. Each part of the platform must load from one row of a plug-in list, and must be replaceable with no change to another part. The system needs a framework for plug-ins, services and events that runs in the Cloudflare Workers runtime and in Node.

## Decision

The plug-in framework is cordis, the published npm package, pinned to one exact version. Only `packages/core` imports cordis. Each other package uses the plug-in lists, the hook points and the port keys that `packages/core` gives.

## Consequences

- A change of framework changes only `packages/core`.
- Requirement C3 has a test that fails when a different package imports cordis.
- Task 01 must prove that cordis runs in the Workers runtime and in Node 26, and that it type-checks with TypeScript 7.

## Alternatives Considered

- A small plug-in system of our own: more code to write and to test.
- Direct imports between packages: this breaks requirement C2, and a part cannot be replaced with one row.
