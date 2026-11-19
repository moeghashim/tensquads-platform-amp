# Task 12: a real model for Petra

Read first: `docs/ARCHITECTURE.md`, sections 4.6 and 10.2. PRD requirements N1 to N9, decisions D24, D26 and D30, and section 11. The report of task 01. Plan: https://tensquads-plan.pages.dev/#4-how-petra-works, #how-petra-decides, #5-how-the-owner-speaks-to-petra.

## Goal

Petra uses a real large model. An owner can send her a message on staging and get a real answer.

This task needs a staging Worker for its tests that are marked [staging]. If task 13 has not made the staging resources, do step 1 of task 13 first, in this pull request.

## Build

1. The instructions of Petra, from the plan, Part 4: who she is, her decision sequence, what she does not do. Her eight tools stay the same (task 08 added "remember a fact" and "promote a fact").
2. A real adapter for the model port, `packages/adapters-model`. The provider and the name of the model are settings, not code. If the report of task 01 says that the model layer of pi runs in the Workers runtime, build one adapter on it. If not, build one small adapter for each provider.
3. The model profile of an account (decision D30): "real" selects this adapter, and "test" selects the fake model. The plug-in list of the tests has no real adapter (N2).
4. The key of the model is a secret of the Worker. It is not in the repository, in a log, in a trail row or in an error message (N3).
5. Each real call adds one cost row with the units that the model port reports. The price list has the price of the provider, set with `SetUnitPrice` (N4). The versions of each attempt now record the real provider and model.
6. The language of an answer, selected by our code: Arabic script, Latin script, or the language of the account (N9).
7. When the model fails or is too slow, Petra tries one more time. Then she tells the owner with a fixed message (N6).
8. For an account with the "real" profile, the decider that asks the model port uses the real model too. Each answer is one decision record with its real time and cost.
9. `scripts/chat.mjs`: a small chat with Petra on staging, from a terminal. It also starts the launcher on the same machine.
10. Ten eval cases for Petra with the real model, from the plan, Part 12, group P and group J. Two of them are in Arabic. `npm run evals -- --real` runs them against staging. They do not run in CI.
11. The swap (N7). The model port must work with OpenAI, Anthropic, Grok, Muse (the code model of Meta), Gemini, DeepSeek and GLM. For each provider that has a key, the swap is four changes: one row in the plug-in list, one setting, one secret, and one price with `SetUnitPrice`. Test two providers or more.
12. The cost of each model (N8): the view gives the average cost of one command of an owner. Run the ten eval cases with each model that has a key, and put the reports side by side. Name each provider that has no key as "not tested".

## Done

- One test for each of N1 to N9, with the id in the test name. N2, N3, N4, N6 and N9 pass in CI with the fake model. N1, N5, N7 and N8 run against staging, and the pull request has their output.
- The test of N9 in CI has three messages: Arabic script, Latin script, and only numbers. The instruction to the model has the correct language each time.
- The test of N5 asks Petra, with the real model, to do a refund herself. No action starts.
- The pull request has the report of the ten eval cases, three runs each, for each model that was tested: the pass rate, the cost and the time.
- The pull request shows the full difference of one swap. It is the four changes of N7 and nothing more.
- The recording shows a chat with Petra in English and in Arabic.

## Not in this task

A real model for a bot. A real decision model. A screen.

## Stop and ask

- If Moe did not give the key of OpenAI, or gave a key for fewer than two providers.
- If a provider in the list has no interface that the adapter can use. For Muse, report what interface Meta gives, before you write code for it.
- If an instruction of Petra is not in the plan.
