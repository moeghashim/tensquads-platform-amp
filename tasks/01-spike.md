# Task 01: the spike

Read first: `docs/ARCHITECTURE.md`, sections 3, 4 and 11. PRD sections 4, 5 and 14. The README of pi-durable: https://github.com/earendil-works/pi/tree/main/packages/durable. The README of cordis: https://github.com/cordiverse/cordis.

## Goal

Prove, with the smallest code, that the main decisions work together. This task gives a report. Its code can be thrown away.

There are two loops, so there are two parts to prove: the loop of Petra in a Durable Object, and the agent loop of a bot in a Node process that stands in for a sandbox.

## Build

Part A, a test Worker with one Durable Object. It:

1. starts a cordis core with two small plug-ins;
2. opens a pi-durable harness on the SQLite of the Durable Object, with `onWake` and the alarm;
3. runs one conversation with a fake model that asks for one fake tool;
4. has one small work list of its own that also needs the alarm;
5. accepts one WebSocket with hibernation;
6. connects to a Postgres database.

Part B, a small Node program that stands in for the runner. It:

1. starts a cordis core with the same two plug-ins;
2. opens a pi-durable harness on a local SQLite file;
3. runs one conversation with a fake model and a fake tool;
4. calls a cordis hook point from the pi-durable hooks `beforeRequest`, `beforeTool`, `afterTool`, `afterTools` and `onYield`;
5. sends a copy of the journal file to a small HTTP endpoint of the test Worker, after each turn and before one tool that stands in for an action.

## Tests

The ids of the spike tests start with "SP", so that they are different from the requirement ids of the PRD.

Part A, inside the Workers runtime:

- **SP-A1.** cordis loads and starts in the Workers runtime.
- **SP-A2.** cordis and pi-durable type-check with TypeScript 7. If not, say which errors, and test with TypeScript 5.9.
- **SP-A3.** The Durable Object is stopped after a tool request and before the tool result. After a restart, the run continues and the tool runs one time. Do the test with a tool that is declared `replay: "safe"` and with one that is not, and report what the model gets.
- **SP-A4.** One alarm handler calls `onWake` of pi-durable and continues our work list. Both get their wake at the correct time.
- **SP-A5.** The Durable Object keeps a WebSocket with hibernation while pi-durable uses the alarm. A message goes out on the WebSocket after a wake.
- **SP-A6.** The model layer of pi (`@earendil-works/pi-ai`) makes one model request from the Workers runtime, to a fake HTTP server.
- **SP-A7.** The Durable Object runs one transaction with `SET LOCAL` and one insert, against three targets: a local Postgres from the local emulator, a Postgres service from the Workers test runtime, and a Neon branch from a deployed Worker. Test these drivers and name the one that works in all three: `pg` over `cloudflare:sockets`, `postgres`, the Neon serverless driver, and Hyperdrive. If no single driver works, say which driver works where.
- **SP-A8.** Find the interface of pi-durable that removes or replaces an old conversation. Use it, and prove that a new conversation works after it. If there is no such interface, report it.

Part B, in Node 26:

- **SP-B1.** cordis loads and starts in Node 26, with the same plug-in code as in part A. If a library or a tool does not work on Node 26, name it and stop.
- **SP-B2.** A steer message that is submitted during a tool call is taken after the tool round.
- **SP-B3.** `beforeRequest` removes one text from the model request. The model does not get it. After the process is killed and a new process continues from a copy of the journal, `beforeRequest` removes the text again.
- **SP-B4.** `onYield` rejects one answer, and the run continues.
- **SP-B5.** The process is killed during a turn. A new process gets the last copy of the journal, calls `resume()`, and completes the task. Report which work ran again.
- **SP-B6.** The process is killed after the copy that comes before the action tool, and before the tool result. In the new process, the tool call has the same id. Report where the id comes from, and if it occurs only one time in a task of 30 turns.
- **SP-B7.** Measure the size of the journal copy and the time to send it, for a task of 3 turns and a task of 30 turns.
- **SP-B8.** A tool that is declared `replay: "safe"` parks: it returns a sleep on a signal. The process saves the journal and exits. A new process opens the copy and delivers the signal. `execute()` runs again with the same tool-call id and returns a result. The model never got a "wait" result. Do this three times in one task, and report if the restart limit of pi-durable counts a park.
- **SP-B9.** Delete the journal copies of one task. A second task is complete and correct.
- **SP-B10.** One tool is declared `replay: "safe"`. Its `execute()` sends a copy of the journal, then calls an endpoint that saves an answer by the tool-call id. The process is killed after the endpoint answered and before the result is committed. In the new process, the tool runs again with the same id, the endpoint gives the saved answer, and the model does not ask for the tool a second time. Do the same test with a tool that is not declared so, and report what the model gets.
- **SP-B11.** A message is submitted with a request id, and the process is killed before the next copy of the journal. The new process submits the same message with the same request id, and also one that the copy already has. The model gets each message one time.

## Done

- A report in the pull request: each test, pass or fail, with the output. The same report as a file in `docs/evidence/01-spike/`.
- The exact versions of cordis, pi-durable and the database driver that you pinned.
- A clear answer to each of these questions:
  1. Are copies of the journal sufficient (ARCHITECTURE section 4.3), or do we need a storage that sends each commit to the gateway?
  2. Is the id of a tool call stable and found only one time in a task (section 4.4)? If not, what is a stable id?
  3. Which database driver do the two adapters use?
- Stop. Wait for Moe before task 02.

## If a test fails

Do not work around it. Report it with the evidence and with two options.
