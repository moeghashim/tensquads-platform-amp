# Task 08: the memory

Read first: `docs/ARCHITECTURE.md`, sections 4.5, 7.2, 7.7, 7.8 and 10.1. PRD requirements M1 to M13, decisions D10, D11, D31 and D32. Plan: https://tensquads-plan.pages.dev/#memory, #learning, and the test cases at #the-memory.

## Goal

The four layers of the memory, with origin, forget, search, the night job and the deletion of customer data.

## Build

1. `packages/memory`: the four layers (M1). The system sets the origin of each fact (M2, M3).
2. Pages: each page accepts facts from one bot, from the definition of the bot. A fact from the owner is a separate row (M4).
3. Search by words, limited by the read list of the bot and by the account (M5, M6). The text is made regular first: the forms of alef, the diacritics and the tatweel. The search column uses the `simple` configuration (M12).
4. The core, with the two limits of 20 and 25 items (M7).
5. Forget and undo: hidden at once, deleted after 30 days (M8).
6. Forget during a task: the forget list of the task, returned in full by `start` and `inbox`, and the check of a result for a forgotten fact (M9).
7. The schedule of the night job: the cron trigger, the Platform object, the "jobs" queue, one job for each account and each local date (M11).
8. The night job: it reads the messages of the same local day and proposes three items or fewer for each week (M10). The evidence of a proposal has ids of messages only.
9. The customer reference, set by our code (ARCHITECTURE section 7.8).
10. The deletions in the night job: forgotten facts after 30 days, the drafts and journal copies of ended tasks, and the personal data of a customer after 12 months, in each place of section 7.8 (M13). An open task that holds the data is cancelled first, with the four steps of section 7.7. A fact or a core item that the owner approved is cleaned and kept.
11. The conversation of Petra: a new one each 90 days, only when she is idle, through the interface of pi-durable that the report of task 01 names. Petra removes each forgotten fact from her own model requests.

## Done

- One test for each of M1 to M13, with the id in the test name. All pass in CI.
- The test of M9 runs the full path: a fact is in the brief, the owner forgets it during the task, the runner is killed, and the model request of the new attempt does not have the text.
- The test of M11 uses a clock that the test controls, with one account in `Asia/Riyadh` and one in `America/New_York`. Each one gets one night job for each local date, also on a day with a clock change.
- The test of M12 finds an Arabic fact with a word that has a different form of alef, and with a word with diacritics.
- The test of M13 has one row in each place of section 7.8 for one customer. After 12 months and one night job, the test reads each place and finds no text of that customer. The data of a second customer is not changed. An approved fact with the name of the customer stays, with no name in it. A second night job does not change it again.
- A test asks for a deletion while a sandbox runs and an action of the task is "started". That night, the task is cancelled, each later gateway call is refused, and nothing is deleted. After the action is "done", the next night job deletes the data. The credits went back one time.
- A test forgets a fact that is in the conversation of Petra. Her next model request does not have the text.
- The recording shows a forget, an undo, and a search in Arabic.

## Not in this task

Embeddings. Learning from the work of the bots. Signals.

## Stop and ask

- If the plan gives a deletion rule that section 7.7 or 7.8 does not have.
- If a place holds text of a customer and is not in the table of section 7.8.
