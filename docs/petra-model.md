---
summary: "The real model of Petra (task 12): the settings, the prices, the swap of a provider, the chat and the real evals"
read_when:
  - Setting up or changing the model of Petra on staging.
  - Swapping the model provider of Petra (requirement N7).
  - Running scripts/chat.mjs, npm run test:staging or npm run evals -- --real.
---

# The real model of Petra

An account with the "real" profile (decision D30) gets the row `piModel` in the plug-in list of Petra (`apps/platform/src/plugins/petra.ts`). Each other account, and each test, gets the row `petraTestModel`: the fake model of the list (requirement N2). The real row is used by the loop of Petra, by her night job and by her model decider.

The instructions of Petra are in `packages/petra/src/instructions.ts`.

## Settings

| Name | Kind | Value |
|---|---|---|
| The provider | The row `piModel({ provider: "openai", ... })` | openai, anthropic, xai, meta (Muse), google, deepseek or zai (GLM) |
| `PETRA_MODEL` | A var in `apps/platform/wrangler.jsonc` | The model, for example `gpt-6.2-sol` |
| `PETRA_MODEL_BASE_URL` | An optional var | An other address of the provider, for example for GLM |
| `<PROVIDER>_API_KEY` | A secret of the Worker | The key, for example `OPENAI_API_KEY`. Never in the repository, a log, a trail row or an error |
| `MODEL_TIMEOUT_MS` | A var | 60000. After a failure or this time, Petra tries one more time, then sends a fixed message |
| `IDENTITY_TOKENS` | A secret of the Worker, on staging | JSON: each token and its principal. With no secret, the test identity stays |

## Prices

Set each price with `SetUnitPrice`. The prices are in millionths of a US dollar for one million tokens, from the pi-ai catalog (the long-context tiers are not used).

| Provider | Model | `1M input tokens` | `1M output tokens` |
|---|---|---|---|
| openai | gpt-6.2-sol | 2000000 | 10000000 |
| anthropic | claude-sonnet-5-5 | 2000000 | 10000000 |
| xai | grok-4.7 | 2000000 | 6000000 |

## The swap (requirement N7)

A swap is four changes: the row, the setting, the secret and the price. From OpenAI to Anthropic:

1. In `apps/platform/src/plugins/petra.ts`: `piModel({ provider: "openai", ...` becomes `piModel({ provider: "anthropic", ...`.
2. In `apps/platform/wrangler.jsonc`: `"PETRA_MODEL": "gpt-6.2-sol"` becomes `"PETRA_MODEL": "claude-sonnet-5-5"`.
3. The secret: `wrangler secret put ANTHROPIC_API_KEY`.
4. The price: two `SetUnitPrice` commands for anthropic, claude-sonnet-5-5, with the prices of the table.

## Commands

- `npm run chat`: a chat with Petra on `CHAT_URL` with `CHAT_TOKEN`. It starts the launcher with `LAUNCHER_KEY`.
- `npm run test:staging`: the tests N1, N5, N7 and N8 against staging. The settings are at the top of `apps/platform/test-staging/staging.test.ts`.
- `npm run evals -- --real`: the ten cases of `evals/cases/real` against `STAGING_URL`, with `STAGING_ADMIN_TOKEN` and `LAUNCHER_KEY`. The staging Worker needs `EVAL_OWNERS=yes` during the run. On staging, the token of an eval owner is the token of a super admin, a space, and `eval-owner:{accountId}`, so a person cannot guess it. Set `EVAL_OWNERS=no` again after the run.

## Deploy to staging

The staging Worker is `tensquads-platform`, with the Neon database `tensquads_amp`. Run the migrations with the owner URL of that database, then deploy from `apps/platform`:

```
npx wrangler deploy --no-x-provision --var WORKER_COMMIT:$(git rev-parse --short HEAD)
```

`--no-x-provision` stops wrangler from checking the R2 bucket with the API. The Cloudflare token of Stripe Projects has no R2 permission. Moe made the bucket `tensquads-files` in the dashboard, because `stripe projects add cloudflare/r2:bucket` failed with an internal error of the provider.

After a deploy, wait about 30 seconds. Some requests reach the earlier version of the Worker during that time.
