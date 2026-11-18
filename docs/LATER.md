---
summary: "Each item that is out of scope for PRD 1"
read_when:
  - Checking if a feature is in scope for PRD 1.
---

# What comes after PRD 1

Owner: Moe Ghashim. Date: 18 November 2026.

This file lists each thing that is out of scope for PRD 1. It is the start of the next build documents. Nothing here is a decision about a date or a sequence. Do not build an item from this file.

## The bots

| Item | What PRD 1 has in its place |
|---|---|
| The four specialist bots: Machu, Angkor, Kyoto, Greenwich, with their instructions, skills and tools | A fake bot, `bot-test` |
| A real model for each bot | A fake model with scripts |
| The image of each bot | The runner as a local process that the launcher starts |
| The evals of each real bot | The base for evals, with five cases for the fake bot and ten cases for Petra |

## The services

| Item | What PRD 1 has in its place |
|---|---|
| The real sandbox on boat.dev | The sandbox port, with a launcher that starts a local process |
| The limit of the network of a sandbox to permitted hosts | Not built |
| The keys of real services on Cloudflare, with the pass for a sandbox | The pass only. No real key except the model of Petra |
| The decision model Jev, in shadow mode first | The decider port, the decision record and the shadow mode, with the large model as the first decider |
| Email and phone for Petra (AgentMail, AgentPhone) | A channel port with a test adapter |
| Google Maps for Greenwich | A port with a test adapter |
| Payments | A port with a test adapter |

## The owner

| Item | What PRD 1 has in its place |
|---|---|
| The owner app and all its screens | A chat with Petra from a terminal |
| The UI library `@tensquads/ui`, and cards in the chat | Typed messages to the owner, with no layout |
| A real sign-in | An identity port with a test adapter |
| Prices, packages and the purchase of credits | The ledger and the credit check |

## The team

| Item | What PRD 1 has in its place |
|---|---|
| The screens of the super admin | The cost rows, the views, and read endpoints that answer in JSON |
| Revenue for each account, from subscriptions and credit packs | The cost side only |
| A gate that blocks a release when an eval fails | The eval runner and its report |
| A state chart of one task that is checked against a model | A chart by hand, in `docs/ARCHITECTURE.md`, section 5.1 |

## Petra

| Item | What PRD 1 has in its place |
|---|---|
| Signals: Petra sees a pattern, such as three complaints of the same type in one week | Not built |
| The performance review of the bots by Petra, and her suggestions to the owner | Not built |
| Learning: the night job proposes an item for the core from what the owner did | The night job with the fake model, and the limits of the core |

## Versions and releases

| Item | What PRD 1 has in its place |
|---|---|
| A version for each bot image, and how an image is built and released | Each attempt of a task records the versions that it ran with |
| A task that runs during an update finishes on its version | Not built |
| How to go back to an older version of a bot or of the platform | Not built |
| The three release steps of the plan: Draft, Beta, Stable | Not built |
| How the platform itself is deployed to production, and a production place | Staging only |

## Safety and operations, not decided

| Item | What PRD 1 has in its place |
|---|---|
| A spend limit for each account for each day | A limit of turns and of budget for each task only |
| How long an approval record stays | It stays, with a hash and no content |
| A task that waits for the owner for a very long time | It stays open. It is cancelled only when a deletion is due |
| Tests with hostile text that tries to give an instruction to Petra or to a bot | The origin "not trusted", and the gate |
| Logs and alerts for errors of the platform itself | The trail and the operations view |
| Backup and restore of the database | Not built |
| The end of an account: closing it and deleting its data | Not built |

## Later options in the plan

- A private store for each account, with one central database.
- The pilot for one restaurant, with the 41 cases of the plan, Part 12.
