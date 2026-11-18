# Task 13: staging and the demo

Read first: `docs/ARCHITECTURE.md`, sections 3.6, 5 and 10.2. PRD sections 9 and 11, decision D30.

## Goal

The platform runs on real Cloudflare and Neon. A fixed demo and a chat prove it.

## Build

1. Create the staging resources with the Stripe Projects CLI: the Worker with its two Durable Object classes, two Queues, one cron trigger, one R2 bucket, one Neon project. Skip a resource that task 12 already made.
2. Run the migrations, then deploy.
3. With admin commands, make two accounts on staging: one with the "test" profile for the fixed demo, and one with the "real" profile for the chat. Each `CreateAccount` gives the account its first credits with `initialCredits`.
4. `scripts/demo.mjs`: starts the launcher on the same machine, runs the fixed demo of PRD section 9, item 4, on the account with the "test" profile, and prints the trail, the decision records, the cost rows and the cost view. Petra and the Platform object run on staging. The runner is a process that the launcher starts.
5. A second mode of the script kills the runner process during the task (item 5).
6. A third mode runs the fixed demo two times on two new accounts, and compares the two outputs. They must be the same, except the ids and the times.
7. Record both runs, and a chat with Petra from `scripts/chat.mjs` on the account with the "real" profile.

## Done

- Each item of PRD section 9 is true, with its evidence in the pull request.
- The pull request has a table: each requirement id of PRD section 8, its test, and the CI run or the staging run that passed it.
- `progress.md` has one entry for each task, with what was learned.

## Stop and ask

If the Stripe Projects CLI is not installed, if it needs a sign-in in a browser, or if it cannot create one of the resources.
