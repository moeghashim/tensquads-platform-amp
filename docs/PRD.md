---
summary: "PRD 1: the scope, the decisions D1 to D33 and the requirements of the first build of the tensquads platform"
read_when:
  - Starting any task of PRD 1.
  - A requirement id or a decision number is named.
---

# PRD 1: the tensquads platform

Owner: Moe Ghashim. Date: 18 November 2026. Status: revision 2, after the plan review. Approved for the receipt step.

This document tells the building agent what to build first. Write all code comments, commit messages, pull requests and questions in Simplified Technical English: short sentences, one idea in each sentence, active voice.

## 1. Goal

Build the platform of tensquads, with Petra and with no specialist bot.

The platform is the part that each bot needs: the plug-in core, the two writers, the loop of a bot, the gate for actions, the check of a result, the credits, the costs, the trail, the memory, the decisions and the base for evals. The first build proves that these parts work together on Cloudflare and Neon. Petra uses a real model. A fake model and fake tools do the work of a specialist bot.

The build is done when section 9 is true.

## 2. Sources and authority

1. **The plan of Moe:** https://tensquads-plan.pages.dev. It is the source for behaviour and for words. Use its words: bot, squad, credit, plug-in, Petra, trail, core.
2. **This PRD.** It is the source for the scope of the first build and for the decisions in section 4. If this PRD and the plan disagree on scope, this PRD wins. If they disagree on behaviour, stop and ask Moe.
3. **`docs/ARCHITECTURE.md`.** It is the reference for how the parts connect. Follow it. Its section 1 says what to do when it cannot work.

No other document is a source.

Never guess. If a behaviour is not in the plan, not in this PRD and not in the architecture document, stop and ask Moe with a numbered list. Each question has a recommended answer.

## 3. Scope

### In scope

| Part | What it is | Plan |
|---|---|---|
| Plug-in core | The cordis core, the plug-in lists, the ports, the boundary tests | [Part 9](https://tensquads-plan.pages.dev/#everything-is-a-plug-in-with-a-proof) |
| The two writers | Petra, one for each account. The Platform object, for the data that has no account | [Part 9](https://tensquads-plan.pages.dev/#where-the-state-is) |
| The loop of a bot | pi-durable as one plug-in, in a runner in a sandbox: brief, turns, attempts, messages, limits, the pass and the gateway | [Part 6](https://tensquads-plan.pages.dev/#how-petra-and-a-bot-speak-during-a-task), [Part 9](https://tensquads-plan.pages.dev/#the-engine-of-the-loop-pi-durable) |
| The gate | Actions with one id, approvals of the owner, limits of the owner | [Part 6](https://tensquads-plan.pages.dev/#6-how-a-bot-does-a-task), [Part 9](https://tensquads-plan.pages.dev/#the-loop-in-detail) |
| The check of a result | Tests by code, then a checker model | [Part 6](https://tensquads-plan.pages.dev/#how-a-result-is-checked) |
| Credits and the trail | The credit check, the fixed price of a task, one trail row for each step | [Part 7](https://tensquads-plan.pages.dev/#7-credits-and-prices), [Part 8](https://tensquads-plan.pages.dev/#trails) |
| Memory, four layers | Record of messages, notes, pages, core. Origin, forget, undo, search by words | [Part 8](https://tensquads-plan.pages.dev/#memory) |
| Decisions | The decision points, the decider port, the decision record, the shadow mode | [Part 4](https://tensquads-plan.pages.dev/#fast-decision-model-jev) |
| Costs and the super admin data | One cost row for each thing that we pay for, the unit prices, the views for the team | [Part 7](https://tensquads-plan.pages.dev/#price-cost-and-the-super-admin-dashboard) |
| The base for evals | The case format, the runner, the comparison of two versions, the eval of the decider | [Part 9](https://tensquads-plan.pages.dev/#evals) |
| Petra with a real model | Her instructions, a real model on staging, a swap of the model, the cost of each model | [Part 4](https://tensquads-plan.pages.dev/#4-how-petra-works) |

### Out of scope

- The four specialist bots, their instructions, skills and images.
- A real model for a specialist bot, a real boat.dev sandbox, Jev, AgentMail, AgentPhone, Google Maps and payments. Each one is a port with a test adapter.
- The owner app and all screens. The Next.js app of the starter stays as it is. The UI library is a separate repository (decision D16).
- A real sign-in. An identity port has a test adapter.
- Prices, packages and the purchase of credits. Only the ledger and the credit check are in scope.
- The screens of the super admin. Only its data and its views are in scope.
- Signals, the performance review by Petra, and learning from the work of the bots.
- Versions and releases of bot images.
- The feature list of Part 10 and the pilot cases of Part 12 of the plan, except the cases that the task files name.

Each thing that is out of scope is in `docs/LATER.md`.

## 4. Decisions

These decisions are final for this build. Do not reopen them. If one cannot work, stop and report with evidence.

| # | Decision |
|---|---|
| D1 | The repository is `moeghashim/tensquads-platform-amp`. It starts from the starter `moeghashim/pi-starter`. Nothing comes from the old repository. |
| D2 | The plug-in framework is cordis, the published npm package, pinned to one exact version. Only the core imports cordis. |
| D3 | The engine of the loop is pi-durable (`@earendil-works/pi-durable`), pinned to one exact version. It runs as one plug-in behind a port. |
| D4 | Petra and her own loop run on Cloudflare, in one Durable Object for each account. The agent loop of each bot runs in a sandbox, one sandbox for each attempt of a task. The sandbox is on boat.dev. In this build, a launcher starts the runner as a local process. |
| D5 | The loop has hook points, and they are cordis events. The loop calls them from the pi-durable hooks (`beforeRequest`, `beforeTool`, `afterTool`, `afterTools`, `onYield`). The gate, the check, the credits, the costs and the trail run on Cloudflare, behind one gateway that the sandbox calls. |
| D6 | There are two writers of the database, and both are in the `petra` package. Petra writes the data of her account. The Platform object, one Durable Object with a fixed name, writes the data that has no account. Each other part sends a command to a writer. |
| D7 | The database is Neon (Postgres). One database, with row-level security and three database roles as the second safety layer. |
| D8 | Each action that goes out has one id: the task id and the id of the tool call in the journal. The runner saves the journal before it asks for an action. An action tool can run again after a stop, with the same id. An action that waits for the owner parks, and continues with the same id. The gate does not do the same id two times, and it refuses the same id with a different content. If a service cannot confirm an action, the gate does not repeat it, and Petra tells the owner. |
| D9 | A bot saves the files of its tools in a draft store in Cloudflare R2 after each step that changes a file. A new attempt loads the draft. |
| D10 | The night job stops its proposals when the core has 20 items. At 25 items, Petra adds no new item until the owner removes one. |
| D11 | Forget during a task: Petra adds the id of the fact to the forget list of the task. The list stays for the whole task. The runner removes the text of each fact on the list from each model request, also after a new attempt. The check of the result tests that the result does not use the fact. The journal copies of the task stay readable for the runner of that task only, so that the task can continue. Our code deletes them 30 days after the forget. |
| D12 | Real services in this build: Cloudflare Workers, Durable Objects, Queues, R2, Neon, and one large model for Petra. All other services are test adapters. |
| D13 | Sign-in is an identity port with a test adapter. |
| D14 | The building agent works on the computer of Moe, for the time being. It pushes through the no-mistakes gate, as the starter says. Section 10 also gives the path for a session with no gate program. |
| D15 | The Stripe Projects CLI creates the Cloudflare and Neon resources and holds their keys. It runs on the computer of Moe, because its sign-in needs a browser. |
| D16 | The UI library is `moeghashim/tensquads-ui` (`@tensquads/ui`). This build does not import it and builds no component. Each message from Petra to the owner is typed data with a zod 4 schema, so the UI library can show it later. |
| D17 | A sandbox holds no key and has no database access. It gets a pass for one account, one bot, one task and one attempt, with an end time. It can only call the gateway. The Platform Worker checks the signature and the end time of the pass. Petra checks that the task is open and that the attempt is the current one. |
| D18 | Each small decision of the system is a decision point in one list. A decider answers the question with a probability. Our code applies the rule of the owner. An answer of a decider alone never moves money and never publishes. |
| D19 | The first decider is the model port. On staging, that is the real model of Petra. A second decider can run in shadow mode: it answers the same questions and does not act. Both answers are recorded. |
| D20 | Credits and costs are separate records. A credit is what the owner pays: one fixed price for each task. A cost is what we pay: one cost row for each thing, with its account and its task. A model call that runs again after a failure is a real cost, and it is recorded. |
| D21 | A shared cost, such as the database, the object store and the Worker, is divided between the accounts by usage. |
| D22 | Only the super admin can read a trail, and each read is recorded. Admin calls cannot read or change the business data of an account in any other way. |
| D23 | The base for evals is in this build: the case format, the runner and the eval of the decider. The evals of the specialist bots come later. |
| D24 | Petra uses a real large model on staging, through the model port. The model is a plug-in. The model port must work with these providers: OpenAI, Anthropic, Grok (xAI), Muse (the code model of Meta), Gemini (Google), DeepSeek and GLM. The first provider is OpenAI. The tests in CI use the fake model. |
| D25 | The decision model of tensquads is Jev, from TypeSafe. It is not in this build. When we add it, it is the second decider, in shadow mode first. The decider port must fit Jev: several typed questions in one call, and a probability for each answer. |
| D26 | The cost of each model is measured. Each cost row of a model call has the provider and the model. The eval runner compares models on the same cases and reports the pass rate, the cost and the time of each one. |
| D27 | The repository uses Node 26, in `.nvmrc`, in the `engines` fields, in CI and for the runner. |
| D28 | A task has attempts. Each start of a sandbox for a task is a new attempt with the next number. The attempt number is in the pass, in each trail row and in each cost row. Thus the rows of a turn that runs again are kept beside the rows of the first run, and no row is lost or mixed. |
| D29 | The definition of a bot is data in one package, `bots`: its version, its task types with their price and limits, its tools with the kind of each action, its read list, and the pages that accept its facts. Petra and the runner both import it. The instructions and the skills of a bot are in its plug-in, in the runner. |
| D30 | Each account has a model profile, "real" or "test", that only a super admin sets. On staging, the account of the fixed demo uses "test", so that the demo gives the same result each time. The account of the chat uses "real". |
| D31 | The night job of an account runs one time for each day, at 02:00 in the time zone of the account or at the first full hour after it. A cron trigger runs each hour, and the Platform object starts the job for each account where it is 02:00. |
| D32 | Retention: a trail is deleted one month after its task ended, and never for an open task. The personal data of a customer of the business is deleted or cleaned 12 months after the last message of that customer, in each place that `docs/ARCHITECTURE.md`, section 7.8, lists. |
| D33 | One command starts one task or none. The id of the task is the command id. |

## 5. Architecture of the first build

```
Test client, demo script              Outside events, hourly cron
        |                                       |
        v                                       v
Platform Worker (apps/platform) ---- identity port (test adapter)
        |                        |
        v                        v
Petra: one Durable Object     Platform object: one Durable Object
for each account              with a fixed name
  - the loop of Petra           - accounts, owners, unit prices,
  - gate, checker, credits,       shared costs, admin commands
    costs, trail, memory,       - the list of sandboxes to start
    decisions                   - the night jobs, by time zone
  - the gateway
  - writes the data of
    her account
        |            |                 ^
        v            v                 |  a pass for one attempt
      Neon          R2                 |
                              Launcher (apps/launcher)
                                       |  starts
                                       v
                              Sandbox: one for each attempt
                                - the runner (apps/runner)
                                - the agent loop of the bot (pi-durable)
                                - the tools
                                - no key, no database
```

The detail is in `docs/ARCHITECTURE.md`.

## 6. Ports and adapters

| Port | Real or test | What the test adapter does |
|---|---|---|
| Database | Real: Neon on staging. A plain Postgres connection for a developer and for CI | — |
| Object store | Real: R2 | — |
| Queue | Real: Cloudflare Queues | — |
| Model, for Petra | Real on staging, for an account with the "real" profile. Test in all other cases | A script of answers |
| Model, for a specialist bot | Test | A script of answers: text, tool requests, an action request, a question, a wrong result |
| Checker model | Test | Pass or fail by rule |
| Sandbox | Test | Asks the Platform object for a sandbox. The launcher starts the runner as a local process |
| Decider | The model port. Test in CI | A fixed answer with a probability |
| Identity | Test | Two owners and one super admin |
| Channels, payments | Test | Records each send. Can answer "confirmed", "not sent" or "unknown" |

Each port has its contract tests. A real adapter that comes later must pass the same tests.

## 7. Repository layout

Keep the layout and the rules of the starter. Add:

- `apps/platform`: the Platform Worker, with the two Durable Object classes, the Queues, the cron trigger and the R2 binding in its `wrangler.jsonc`.
- `apps/runner`: the Node program that runs the agent loop of one bot in a sandbox.
- `apps/launcher`: the Node program that starts a runner for each sandbox that Petra asks for. It stands in for boat.dev in this build.
- `apps/evals`: the command that runs the eval cases.
- `packages/core`: the cordis core, the ports and the plug-in lists.
- `packages/contracts`: the zod 4 schemas. No code that runs.
- `packages/bots`: the definition of each bot, as data. In this build: Petra and the test bot.
- `packages/<area>`: one package for each plug-in: `petra`, `gateway`, `loop`, `link`, `gate`, `checker`, `credits`, `costs`, `trail`, `memory`, `decisions`, `evals`, `bot-test`, `adapters-test`, `adapters-neon`, `adapters-postgres`, `adapters-cloudflare`, `adapters-model`.
- `db/`: the migrations, numbered, never edited after merge.
- `docs/adrs/`: one ADR for each of the decisions D2, D3, D4, D5, D6, D7, D8 and D28.
- `docs/evidence/<task>/`: the recording of each pull request (section 10).

Rename the package scope from `@pi-starter` to `@tensquads`. Do not use the name `@tensquads/ui`. It belongs to the UI library.

## 8. Requirements

Each requirement has an id. Each one is one test or more, with the id in the test name.

A requirement is done when its test passes in CI on a pull request. Five requirements cannot run in CI, because they need the staging system, a real model or Neon. They are marked **[staging]**. They are V4, N1, N5, N7 and N8. Their tests run against staging, and the pull request has their output.

### Plug-in core (task 02)

- **C1.** The system starts from a list of plug-ins. Each row is one plug-in. A row can be replaced with no change to another plug-in.
- **C2.** No plug-in imports another plug-in. A test reads each file and fails on such an import.
- **C3.** Only the core imports cordis. A test proves it.
- **C4.** No business package imports a database library or an SDK of an outside service. A test proves it.
- **C5.** The start fails with a clear message when a plug-in needs a port that no plug-in provides.
- **C6.** A plug-in that is removed leaves no hook and no handler.

### The two writers (task 03)

- **P1.** Each account has one Petra. Two commands for one account are handled one after the other.
- **P2.** Only the `petra` package can write to the database. Petra writes the tables of her account. The Platform object writes the tables that have no account. A test fails if a different package has a write.
- **P3.** Each row of each account table has the account id. The database has three roles: one for Petra, one for the Platform object, one for the views of the super admin. Row-level security returns zero rows of a different account to Petra. A test with two accounts proves it.
- **P4.** A command that arrives two times gives one result. This is true for a command of an owner and for an admin command. A command that Petra runs again after a stop adds no second task, charge or attempt.
- **P5.** A super admin makes an account with a command to the Platform object. An account has a name, a time zone, a language and a model profile. The command can give the account its first credits, and Petra writes that grant. A super admin adds an owner to an account. No other path makes an account or an owner.
- **P6.** Each write can run two times with the same result. No table has a random value as its only key. A test calls each method of each writer two times and compares the tables.

### The interface of the Platform Worker (task 03)

- **W1.** The Platform Worker has one HTTP interface, with the calls of `docs/ARCHITECTURE.md`, section 6.5. Each call and each answer has a zod schema in `packages/contracts`.
- **W2.** A client sends each command with one call. The answer says that the command is accepted, and it gives the command id. The same command id two times gives the same answer.
- **W3.** Each message to the owner has a sequence number in its account. A client gets the messages in two ways: a list after a sequence number, and a stream. Petra serves the stream on a WebSocket. Both ways give the same messages in the same sequence, and a client that loses the stream continues from its last number.
- **W4.** Each error has one form: a code and a short message. An error never has a key, a stack trace or data of a different account.

### The setup for a developer and for CI (task 03)

- **V1.** One command starts the platform on one machine: the Worker in the local emulator, a local Postgres with the migrations, and the launcher. The steps are in `README.md`.
- **V2.** CI runs the database tests against a real Postgres with row-level security and the three roles.
- **V3.** A new clone passes `npm run doctor`, `npm run check` and `npm test` with only the steps in `README.md`.
- **V4.** **[staging]** The Neon adapter passes the same contract tests as the plain Postgres adapter. This test runs in a separate CI job against a Neon branch, and not on each pull request.

### Messages to the owner (task 03)

- **O1.** Each message from Petra to the owner is typed data, not only text. The types are: reply, question, approval request, result, status, and notice of an action that is not confirmed.
- **O2.** Each type has a zod 4 schema in `packages/contracts`. No type has a field for layout, colour or a component name.
- **O3.** A test runs the fixed demo on one machine, in CI, and proves that each message that it sends passes its schema.

### The loop (task 04)

- **L1.** A task starts with a brief and an empty context. The brief has six parts: goal, done, facts with the id of each row, limits, not in the task, reply to.
- **L2.** A task stops with one name from this list: success, question, waiting, max turns, max budget, error, cancelled. Petra reads the name to know what to do.
- **L3.** Petra can send a message to a task that runs. The loop takes it between two turns and never during a tool call. A message is not lost if the sandbox stops after the runner took it.
- **L4.** A task type has a maximum of turns. At the limit, the task stops with the name "max turns", and no new tool starts.
- **L5.** If a sandbox stops during a task, Petra starts a new attempt one time. A runner that exits on purpose is not a failure, and a report that comes two times adds one attempt. The new runner continues from the last copy of the journal. The turn that was lost runs again. The rows of both attempts stay, and each row has its attempt number.
- **L6.** A task that waits for the owner has no sandbox. A new attempt continues the task after the answer. The tool that waits parks, and the answer of the owner comes back as the result of that same tool call.
- **L7.** Petra can tell what each task does now: the bot, the attempt, the turn, the tool call, how long, the time of the last row. The data comes from the trail rows of the task. The system stores no second copy.
- **L8.** The model, one tool and the checker each load from one row of a plug-in list. A test replaces each one with no change to the loop.
- **L9.** A pass is for one account, one bot, one task and one attempt, with an end time. A call with a pass of a different task, of an old attempt, of a task that ended, or after the end time, is refused.
- **L10.** Each model call of a bot goes through the gateway. The runner never calls a model provider directly.
- **L11.** Each attempt records the versions that it ran with: the commit of the Worker, the commit of the runner, the plug-in lists, the version of the bot definition, the provider and the model.
- **L12.** Petra never starts a process. She asks for a sandbox through the sandbox port. The launcher takes the request and starts the runner with the pass. One attempt has one runner: a second runner for the same attempt is refused. A test proves the full path on one machine.
- **L13.** Petra and the runner read the definition of a bot from the same package. A test proves that both have the same version of it.
- **L14.** If the Durable Object of Petra loses its own storage, Petra makes a new conversation from the messages in the database and continues. Each open task continues, and no message of the owner is lost.
- **L15.** The owner can stop a task in the chat. Petra has a tool "stop a task". It does the same as the `CancelTask` command: the pass ends, the task gets the stop name "cancelled", and the credits follow requirement T3. If the owner has more than one open task and the message does not say which one, Petra asks. Petra tells the owner what was done before the stop.

### The gate (task 05)

- **G1.** Each action with money and each public action goes through the gate, on Cloudflare. An action tool never runs in the sandbox. The runner cannot call a service directly.
- **G2.** An action with money needs the approval of the owner, or it is inside a limit that the owner set. Example: a refund of $15 with a limit of $20 needs no new approval.
- **G3.** A public action always needs the approval of the owner.
- **G4.** An approval belongs to one action with its exact content. A change to the content needs a new approval.
- **G5.** The id of an action is the task id and the id of its tool call in the journal. The runner saves a copy of the journal before it asks the gate for an action. An action tool is declared so that pi-durable runs it again after a stop, with the same id.
- **G6.** The gate writes the action with the status "started" before it calls the service, and "done" after the service answers.
- **G7.** An id that comes again with "done" gives the saved answer. The action does not run again.
- **G8.** An id that comes again with a different content is refused. The refusal is recorded in the trail.
- **G9.** An id that comes again with "started": the gate asks the service, but not while the first call still runs. If the service cannot answer, the gate does not repeat the action, and Petra tells the owner.
- **G10.** When the owner rejects an approval, the action gets the status "rejected". The model gets a refusal with the reason, and no action goes out.
- **G11.** After each step that changes a file, the file goes to the draft store. A new attempt loads the draft first.
- **G12.** The sandbox is killed at four points: before the call to the gate, after "started", after "done", and after the answer came back but before the next copy of the journal. In each case the action goes out one time. A second test stops Petra, not the sandbox, between "started" and "done".

### The check of a result (task 06)

- **K1.** A result goes out only after the check passes: the tests by code, then the checker model.
- **K2.** The maker is not the checker. The checker port has its own row in the plug-in list.
- **K3.** A failed check sends the bot back to work, up to the limits of its task type.

### Credits and the trail (task 07)

- **T1.** A task does not start when the balance of credits is not sufficient. The owner gets a clear message.
- **T2.** A task takes the price of its task type from the credits, as one row in the ledger. The price comes from the definition of the bot. It does not change if the task uses more work or has more attempts.
- **T3.** A task that stops at a limit of turns or of budget gives its credits back, as one row in the ledger. A task that Petra cancels because a deletion is due gives its credits back too. A task that the owner cancels gives its credits back only if no runner started.
- **T4.** The system stores no sum. A balance is calculated from the rows of the ledger.
- **T5.** Each step of each task is one row in the trail: the task, the attempt, the turn, a sequence number, who, what, when and the result. The system only adds rows.
- **T6.** One query gives the full trail of one task, from the message of the owner to the last result, with each attempt.
- **T7.** A large item goes to R2. The trail row keeps a link and a hash.
- **T8.** A job deletes the trail of a task one month after the task ended, with its items in R2. It never deletes the trail of an open task. A trail row with no task is deleted one month after it was written. Approval records stay.

### Memory (task 08)

- **M1.** Four layers: the record of messages, notes, pages and the core.
- **M2.** The system sets the origin of each fact: owner, bot, not trusted, or system. A bot cannot set or change it.
- **M3.** Text from a stranger has the origin "not trusted". It cannot become a rule, and only the owner promotes a fact to the core.
- **M4.** Each page accepts facts from one bot. A fact from the owner is a separate row that a bot cannot change.
- **M5.** Each bot has a read list, in its definition. A search returns only rows from that list and from its own account.
- **M6.** Search is by words. No embedding model.
- **M7.** The core: the night job proposes nothing at 20 items. At 25 items, Petra adds no item until the owner removes one.
- **M8.** Forget: the fact is hidden from search at once. The owner can undo for 30 days. Then the system deletes it. The stored conversation of Petra is the one exception: it can keep the text until its next reset, and Petra never sends it to a model in that time.
- **M9.** Forget during a task follows decision D11. A test forgets a fact, stops the sandbox, and proves that the model request of the new attempt does not have the text. Petra removes a forgotten fact from her own model requests too.
- **M10.** The night job reads only the messages of the same day. It only proposes, three items or fewer for each week.
- **M11.** "The same day" is the day in the time zone of the account. The night job of an account runs at 02:00 in that time zone, one time for each day.
- **M12.** Search by words works for English and for Arabic. It uses the `simple` text search configuration of Postgres, and it makes Arabic text regular first: the forms of alef, the diacritics and the tatweel. A test finds an Arabic fact with an Arabic word that is written in a different form.
- **M13.** The personal data of a customer of the business is deleted or cleaned 12 months after the last message of that customer, in each place of `docs/ARCHITECTURE.md`, section 7.8. A fact or a core item that the owner approved is not deleted: our code removes the name, the address and the number of the customer from it. A test with a clock that the test controls checks each place.

### Decisions (task 09)

- **Q1.** Each decision point is one row in one list: its id, its question, its type (yes or no, choice, score), its options, the harm if the answer is wrong, the level at which an answer is "sure", and what occurs below that level.
- **Q2.** The decider port takes several questions in one call. It returns, for each question, the answer and its probability.
- **Q3.** Each answer is one decision record: the decision point, the id of the message that it is about, the options, the answer, the probability, the decider, the time, and if the system used the answer. The record has no copy of the text of the message.
- **Q4.** An answer below the level, an answer that is not valid, an error or a timeout goes to the next step: Petra, then the owner. The event is never lost.
- **Q5.** In shadow mode, a second decider answers the same questions. The system does not use its answers. It records them beside the first answers.
- **Q6.** When the owner approves, rejects or changes a thing that a decision led to, the system records that outcome and connects it to the decision record.
- **Q7.** Our code applies each rule and each limit of the owner. A test proves that an answer of a decider alone cannot start an action with money or a public action.
- **Q8.** A test replaces the decider with a second one in the plug-in list, with no change to another package.

### Costs and the super admin data (task 10)

- **S1.** Each thing that we pay for is one cost row: the account, the task, the attempt, the kind (large model, decider, checker model, sandbox, outside service, storage, database, worker), the provider, the model when there is one, the units, the price of one unit at that time, and the amount. A report that arrives two times adds one row. A call that really ran two times adds two rows.
- **S2.** The price of one unit is in a price list with a start date. A new price does not change an old cost row.
- **S3.** Costs and credits are in different tables. No table has a stored sum.
- **S4.** A super admin gives the amount of each shared cost for each period, with a command. The Platform object then divides it between the accounts by usage, and each Petra adds one row for her account. The sum of these rows equals the amount. The parts are saved before a share is sent, so a command that runs again gives the same parts. With no usage in the period, the parts are equal.
- **S5.** A correction of a shared cost is a new amount that names the old one. The system adds rows that cancel the old division and rows for the new one. No row changes.
- **S6.** The data gives these views: for each account (cost by kind, credits used, the difference); for each task type (the price, the average real cost, the tasks above their price); for each bot, each model and each decision point.
- **S7.** The data gives an operations view: tasks that are stuck (as `docs/ARCHITECTURE.md`, section 7.6, defines), approvals that wait, actions that are not confirmed, how often the check fails, how often an owner rejects a result, and each period that has no shared cost amount.
- **S8.** The identity port has a super admin role. A super admin can send the four admin commands and read the views. An admin call cannot read or change the business data of an account, except one call that reads the trail of a task and records that read. An owner cannot use an admin call.
- **S9.** A task type has a maximum budget, as an amount of cost. The gateway adds the cost rows of the task, over all its attempts, before each model call. Above the limit, the task stops with the name "max budget".

### The base for evals (task 11)

- **E1.** A case has: an id, the input, the setup (the memory and the rules of the test account), the expected outcome, the grader (code, a model, or a person), and tags.
- **E2.** The runner plays a case through the real loop, several times. No action goes out: the channel and payment ports only record. The report gives the pass rate, the variation between the runs, the cost and the time.
- **E3.** The runner compares two versions on the same cases. A case that passed before and fails now is in the report by name. A better average does not hide it.
- **E4.** A function makes a case from the trail of a task that an owner rejected or changed. It works only while the trail exists. The case has no customer data.
- **E5.** The eval of the decider takes messages with a correct answer. For each decision point it reports: agreement, wrong answers above the level, the time and the cost. It works with each decider adapter.
- **E6.** The cases and the graders are outside the sandbox. A bot under eval cannot read or change them.

### Petra with a real model (task 12)

- **N1.** **[staging]** For an account with the "real" profile, Petra uses a real large model through the model port. The adapter is one row in her plug-in list.
- **N2.** Each test in CI uses the fake model. A test proves that the plug-in list of the tests has no real model adapter.
- **N3.** The key of the model is a secret of the Worker. It is never in the repository, a log, a trail row or an error message.
- **N4.** Each model call adds one cost row with the units that the model port reports, and with the price of the provider from the price list.
- **N5.** **[staging]** With the real model, Petra can only use her own tools: start a task, answer the owner, ask the owner, read the memory, tell the status of a task, stop a task. She cannot start an action with money or a public action. The tool "stop a task" can only stop a task of her account.
- **N6.** When the model fails or is too slow, Petra tries one more time. Then she tells the owner with a fixed message. No message of the owner is lost.
- **N7.** **[staging]** A model of a different provider replaces the first one with four changes and no more: one row in the plug-in list, one setting, one secret, and one price in the price list. The swap test runs for each provider that has a key, and for two providers or more.
- **N8.** **[staging]** The cost view for each model gives, for each provider and model: the number of calls, the units, the cost, and the average cost of one command of an owner. The eval report has the pass rate, the cost and the time of each model that was tested, side by side, on the same cases.
- **N9.** Our code selects the language of an answer of Petra: Arabic when the message of the owner is in Arabic script, English when it is in Latin script, and the language of the account in all other cases. The model gets that language as an instruction.

## 9. Done

All of these must be true. Give the evidence in the last pull request, not a summary.

1. `npm run check`, `npm test`, `npm run agent:check` and `npm run fallow:audit` return 0 in CI on each pull request.
2. Each requirement of section 8 has a test with its id in the test name. Each test passes in CI, or against staging for the six that are marked [staging].
3. The tests of the Durable Objects run inside the Workers runtime. The tests of the runner and of the launcher run in Node.
4. The staging system is deployed. The fixed demo runs on an account with the "test" profile, and it gives the same result each time. One script runs this task and prints the trail:
   - an owner message arrives;
   - the credit check passes, and the price of the task is taken;
   - Petra starts a task with a brief, a pass and a sandbox;
   - in the sandbox, the fake model asks for a tool, and the runner runs it;
   - the owner sends a message during the task, and the loop takes it between two turns;
   - the fake model asks for a refund above the limit, the task waits for an approval, and its sandbox stops;
   - the approval arrives, a new attempt continues the task, and the gate does the action one time;
   - the check passes, and the result goes out;
   - the script prints the trail, the decision records, the cost rows of the task and the cost view of the account.
5. A second run of the fixed demo kills the runner during the task. A new attempt continues the task, and no action runs two times.
6. **[staging]** An owner can chat with Petra on an account with the "real" profile, with `scripts/chat.mjs`. Petra answers with the real model, asks one question when a request is not clear, and starts a task of the test bot when she is asked.
7. A recording shows items 4, 5 and 6.

## 10. How the agent works

- **A receipt first.** Before any code, send one message with: the files you read with a SHA-256 hash for each (`docs/PRD.md`, `docs/ARCHITECTURE.md` and the task file are always in the list), the list of plan sections you read, and the line "Decisions D1 to D33 read. No question." or a numbered list of questions with a recommended answer for each. Then stop and wait for "go" from Moe.
- **One task, one branch, one pull request.** The branch name is the name of the task file. Work on the tasks in the order of section 12.
- **Wait after each pull request.** Do not start the next task before Moe approves the pull request of the current one.
- **Commits.** This PRD requests commits. Author: Moe Ghashim <mohanadgh@gmail.com>. Each commit has a `Signed-off-by` trailer. Use `npm run commit:with-progress` so that `progress.md` gets one line for each task.
- **Push through the gate.** On the computer of Moe, run `no-mistakes init` one time, then push each branch with `git push no-mistakes`, never to `origin` directly. The gate tests the branch and opens the pull request.
- **If the gate program is not installed:** before each push, run `npm ci && npm test`, `npm run check`, `npm run agent:check` and `npm run fallow:audit`, and put the output in the pull request. Then push the branch and open a normal pull request.
- **Tests first.** Write the test of a requirement before its code.
- **A clear expectation and a recording.** Each pull request says, in one or two sentences, what a person can now see or run. It has a recording that shows it. For a task with no screen, the recording is a terminal recording of the new tests and of one command that a person can run. Commit the recording as a small text file in `docs/evidence/<task>/`, so that it is in the branch before the gate opens the pull request.
- **Keys.** Never write a key in code, in a commit or in a pull request.

## 11. Services and keys

- Moe gives the key of OpenAI for Petra. For the swap test and the cost comparison, Moe gives the key and the model name of each other provider that he wants in the report: Anthropic, Grok, Muse, Gemini, DeepSeek, GLM. A provider with no key is not tested, and the report says so.
- Each key goes into the secrets of the staging Worker, by Moe or with his approval.
- Use the Stripe Projects CLI to create the staging resources: one Cloudflare Worker with two Durable Object classes, two Queues, one cron trigger, one R2 bucket, and one Neon project.
- The CLI runs on the computer of Moe. Its sign-in and the first link to Cloudflare and Neon need a browser, so the agent gives Moe the link and the code and waits. If the CLI is not installed, stop and ask.
- Commit the project link that the CLI writes (`.projects/state.json`). Never commit the `.env` file that it writes, and never read it.
- Treat the database as a separate release. Run the migrations before you report a deploy as complete.
- Moe adds the connection of a Neon branch as a secret of CI, for the job of requirement V4.

## 12. Tasks

| # | Task file | Requirements | Result |
|---|---|---|---|
| 00 | `tasks/00-repository.md` | — | The starter is in the repository, on Node 26, with the rules of section 10 and the ADRs |
| 01 | `tasks/01-spike.md` | — | Proof that the main libraries work together. A report. Stop for Moe |
| 02 | `tasks/02-core.md` | C1 to C6 | The cordis core, the ports, the plug-in lists |
| 03 | `tasks/03-writers-and-database.md` | P1 to P6, W1 to W4, V1 to V4, O1 to O3 | The database, the two writers, the interface of the Worker, the setup |
| 04 | `tasks/04-loop.md` | L1 to L15 | The loop, the runner, the launcher, the gateway, the pass, the attempts |
| 05 | `tasks/05-gate.md` | G1 to G12 | The gate, the approvals, the limits, the draft store |
| 06 | `tasks/06-checker.md` | K1 to K3 | The check of a result |
| 07 | `tasks/07-credits-and-trail.md` | T1 to T8 | The ledger and the trail |
| 08 | `tasks/08-memory.md` | M1 to M13 | The memory |
| 09 | `tasks/09-decisions.md` | Q1 to Q8 | The decision points, the decision record, the shadow mode |
| 10 | `tasks/10-costs-and-super-admin.md` | S1 to S9 | The cost rows, the price list, the views, the budget limit |
| 11 | `tasks/11-evals.md` | E1 to E6 | The case format, the runner, the eval of the decider |
| 12 | `tasks/12-petra-real-model.md` | N1 to N9 | A real model for Petra, the swap, the cost of each model |
| 13 | `tasks/13-staging-and-demo.md` | Section 9 | The deployed staging system, the fixed demo, the chat, the recording |

Each requirement belongs to one task. A task uses a test double for a part that comes in a later task, and the later task removes the double.

## 13. The UI library

The screens come later, from `moeghashim/tensquads-ui`. That repository has a working component library, `@tensquads/ui`.

**What is on `main` today.** It has 14 documented components: Badge, Button, Chip, Dialog, Field, Form, Input, Menu, SegmentedControl, Switch, Tooltip, Squadmate, Chat (the log, the messages, the composer, the working line and the error line) and ChatReply (Markdown and streamed OpenUI blocks). It also has the OpenUI bridge: `TensquadsRenderer` on the client and `buildSystemPrompt` on the server. Each part supports English and Arabic with right-to-left layout, and the light and dark themes.

**Where to look.**

- The component list: the "Components" table at the top of `README.md` in `moeghashim/tensquads-ui`, or the agent index `llms.txt` in the same repository.
- The live gallery: https://tensquads-ui-preview.mohanadgh.workers.dev/components.
- The agent skill: `npx skills@latest add moeghashim/tensquads-ui --skill tensquads-ui`.

**How a later build uses it.**

- Install it from a pinned commit, for example `npm install github:moeghashim/tensquads-ui#ec3b531`. Then follow the section "Styles, locale, and theme" of its `README.md`, and import from `@tensquads/ui/react`.
- Use a library component when it exists. Do not build your own.
- Some parts are not on `main` yet. On the branch `v0.2-dashboards`, Card, PageHeader and StatTile are done. BarChart, Bars, Distribution, DataTable, EmptyState, Sidebar, ApprovalCard and ChatLauncher come next, then the demo dashboards for the admin and the store owner. Use each one when it lands. Until a part lands, build only that part in this repository, and mark it to be replaced by the library version.

**Rules for this build.** This build has no screens (decision D16).

- Do not import `@tensquads/ui`.
- Do not write a component, a style or OpenUI text.
- Follow requirements O1 to O3, so that a later build can connect the two with no change to the platform.
- If a type in `packages/contracts` has the same meaning as a schema in the plan of the UI library, use the same name.
- The roles and the process of the UI library do not apply to this repository. The platform uses only the process in section 10.

## 14. What is not confirmed

Nobody has run these. Task 01 tests items 1 to 13. Report each result.

1. cordis runs in the Cloudflare Workers runtime and in Node 26.
2. pi-durable and cordis type-check with TypeScript 7, the compiler of the starter root. If not, the platform packages use TypeScript 5.9, as the web app of the starter does.
3. The pi-durable storage for Durable Objects works as its README says, with `onWake` and the alarm. The loop of Petra uses it. Our code can use the same alarm for the work list of Petra.
4. Our cordis hook points can be called from the pi-durable hooks.
5. A copy of the journal for each turn, and before each action, is fast and small. A new process can continue a task from it.
6. After a new process continues from a copy, a tool call that was not complete keeps the same id, and that id occurs one time in the task.
7. The model layer of pi (`@earendil-works/pi-ai`) runs in the Workers runtime.
8. One database driver works from a Durable Object to a plain Postgres and to Neon. The spike names it.
9. A Durable Object can serve a WebSocket with hibernation while pi-durable uses its alarm.
10. An action tool that is declared `replay: "safe"` runs again after a kill, with the same tool-call id.
11. pi-durable has an interface that removes an old conversation.
12. A tool can park on a signal, the process can exit, and a new process can deliver the signal. The tool then runs with the same tool-call id.
13. pi-durable drops a message whose request id it already has.
14. The Stripe Projects CLI can create Durable Objects, Queues, a cron trigger and R2.
15. Muse, the code model of Meta, has an interface that the model adapter can use.

## 15. Open points that do not block this build

- The cases for the first pilot (Part 14 of the plan).
- Prices and packages.
- The levels of the decision points. Task 09 starts with first values, and Moe confirms them.
- Which repository owns the schemas that the platform and the UI library share.
