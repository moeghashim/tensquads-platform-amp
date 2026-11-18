---
summary: "Task 01 spike report: which main decisions of PRD 1 work together, with the output of each test"
read_when:
  - Starting task 02 or a later task that uses cordis, pi-durable or the database driver.
  - Checking a result of the spike.
---

# Task 01: the spike report

The recording of one full run is `spike-tests.cast` in this folder. The code is in `spike/`. It ran in an Amp orb (Linux, Node v26.13.1), with the Workers runtime of `wrangler dev` 4.158.0 and a local Postgres 17.

## Pinned versions

| Package | Version |
|---|---|
| `cordis` | `4.0.0-rc.13` (a release candidate; no 4.0.0 exists yet) |
| `@earendil-works/pi-durable` | `1.5.2` |
| `@earendil-works/pi-ai` | `1.5.2` |
| `pg` | `8.23.1` |
| `postgres` | `4.1.1` |

## Results

| Test | Result | Evidence |
|---|---|---|
| SP-A1 | Pass | cordis starts in the Workers runtime. Two plug-ins run, and the check plug-in refuses an answer |
| SP-A2 | Pass | `tsc` 7.0.2 type-checks the spike code for Node and for the Worker with no error. With `skipLibCheck: false`, the declaration files of `@types/node`, `@cloudflare/workers-types` and `@google/genai` (a dependency of pi-ai) have errors. The starter already uses `skipLibCheck: true` |
| SP-A3 | Pass | `workerd` was killed with SIGKILL during the tool. After the restart, the `replay: "safe"` tool ran again with the same call id, and the run completed. The tool that is not declared so did not run again. The model got `[error] Tool slow_unsafe was interrupted and may ...` |
| SP-A4 | Pass | One alarm handler served the work list and a pi-durable sleep. Wakes came in the correct sequence: work, pi-durable, work. Each work wake was 2 to 8 ms after its due time |
| SP-A5 | Pass | A WebSocket accepted with hibernation got one message after each alarm wake, while pi-durable used the same alarm |
| SP-A6 | Pass | `streamSimple` of pi-ai made one request from the Workers runtime to a fake OpenAI server, and returned the text and the usage |
| SP-A7 | Partial | See the section below. Two of the three targets ran. The Neon branch from a deployed Worker did not run |
| SP-A8 | Fail | See the section below. pi-durable 1.5.2 has no interface that removes an old conversation |
| SP-B1 | Pass | cordis starts in Node 26 with the same plug-in file as part A |
| SP-B2 | Pass | A steer submitted during a tool call reached the model in the next request, after the tool result |
| SP-B3 | Pass | `beforeRequest` removed a text. After a kill and a resume from a copy, the new process made 3 model requests, and none had the text |
| SP-B4 | Pass | `onYield` refused one answer. The run continued and made one more model call |
| SP-B5 | Pass | Killed in turn 1: the whole turn ran again (model call and tool, with a new call id). Killed in turn 2: turn 1 did not run again, turn 2 ran again. The work after the last copy runs again, as ARCHITECTURE section 4.3 says |
| SP-B6 | Pass | Killed after the copy before the action: the new process had the same call id, and the gate got one action. In a task of 30 tool calls, each id occurs one time |
| SP-B7 | Pass | 3 turns: last copy 118,784 bytes. 30 turns: last copy 167,936 bytes. Mean time to make a copy and save it in R2 (local emulator): 14 to 15 ms |
| SP-B8 | Fail on 1.5.2, pass on pi main | See the section below |
| SP-B9 | Pass | The copies of task A were deleted. Task B completed |
| SP-B10 | Pass | `replay: "safe"`: killed after the endpoint answered; the tool ran again with the same id, the endpoint gave the saved answer, one action id, one model request after the resume. Not declared so: the model got `interrupted`, asked again with a new id, and the endpoint got two action ids. Thus an action without `replay: "safe"` can go out two times |
| SP-B11 | Pass | The new process submitted both messages again with the same request ids. The model got each message one time |

### SP-A7: the database driver

Each driver ran `BEGIN`, `SET LOCAL ROLE ts_petra`, `set_config('app.account_id', ..., true)`, one insert and one count, then the same count for a second account. The table has row-level security on `account_id`.

| Driver | From the Worker | From the Durable Object | Rows of the other account |
|---|---|---|---|
| `pg` over `cloudflare:sockets` | Pass | Pass | 0 |
| `postgres` | Pass | Pass | 0 |
| `pg` through Hyperdrive (local) | Pass | Pass | 0 |
| `@neondatabase/serverless` (Pool) | Fail: `Network connection lost` | Fail | — |

- Target 1, a local Postgres from the local emulator: done.
- Target 2, a Postgres service from the Workers test runtime (`@cloudflare/vitest-pool-workers`): not done. Task 03 sets up that runtime.
- Target 3, a Neon branch from a deployed Worker: not done. It needs a Cloudflare account and a Neon project, which the Stripe Projects CLI creates on Moe's computer (D15).
- The Neon serverless driver needs the Neon WebSocket proxy. It cannot reach a plain Postgres, so it cannot serve both adapters.

### SP-A8: remove an old conversation

`Conversation.reset()` writes a `pi.reset` entry. The model then sees only the entries after it. The old entries stay: the entry count went from 5 to 6. The 1.5.2 types and the changelog have no call that deletes a conversation or its entries.

### SP-B8: a tool that parks

pi-durable 1.5.2 does not export `defineSignal`, and a tool cannot return a park. Signals and parks are on `main` of `earendil-works/pi` (commit `f6d0c2f`, "Unreleased" in the changelog).

The same test against that commit passed: the tool parked three times in one task, each time the process saved a copy and stopped, and a new process delivered the signal. `execute()` ran again with the same call id, and the model got `refund 10 done`, `refund 11 done`, `refund 12 done`, never a wait result. The restart limit was 2, and three parks did not end the task, so a park does not count for the restart limit.

## Answers to the three questions

1. **Are copies of the journal sufficient?** Yes. A copy is 120 to 170 KB and takes about 15 ms to make and save. A storage that sends each commit to the gateway is not necessary.
2. **Is the id of a tool call stable, and found one time in a task?** Yes, when the runner saves a copy before the action (SP-B6, SP-B10). The id comes from the tool call in the answer of the model, which the journal stores. A real provider gives its own id. If the sandbox stops before that copy, the model is called again and the call gets a new id; the gate never saw the old one.
3. **Which database driver do the two adapters use?** `pg` over `cloudflare:sockets` is the recommendation. It works from the Worker and from the Durable Object, directly and through Hyperdrive. It is not proven against Neon yet.

## Failures, with two options each

**SP-B8: no park on a signal in pi-durable 1.5.2.** Sections 4.4 (wait for the owner), L6 and G12 depend on it.

1. *Recommended:* wait for the next release of pi-durable, then pin it (D3 says one exact version). Tasks 02 and 03 do not need parks, so they can start now. Task 04 needs the release.
2. Pin a commit of `earendil-works/pi` main through a git dependency or a vendored tarball. This works now, but the API is marked experimental and changes without notice.

**SP-A8: no interface that removes an old conversation.** Section 4.6 (the 90-day reset) and the deletion rules of section 7.7 depend on it.

1. *Recommended:* make a new conversation with `createConversation()` from the messages in the database, make it the conversation of Petra, and ask the pi-durable team for a delete call. The old `pi_` rows stay until then. This is a gap in rule 7.7 for forgotten text in the conversation of Petra.
2. Delete the `pi_` rows of the old conversation with our own SQL. Section 4.6 forbids this now.

## Decisions of Moe (18 November 2026)

- **SP-B8:** pin the unreleased pi-durable of `earendil-works/pi` main. Only `packages/loop` imports pi-durable (D3), so the pin goes in with task 04. Task 04 pins one exact commit and replaces it with the first release that has signals.
- **SP-A8:** Petra starts a new conversation from the messages in the database. The old `pi_` rows stay until pi-durable has a delete call.

**SP-A7: Neon not tested.** Test target 3 in task 13, or earlier if Moe creates a Neon branch. If `pg` fails on Neon, use the Neon serverless driver in `adapters-neon` and `pg` in `adapters-postgres`, with the same contract tests.
