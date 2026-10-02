# Natural-language search: evaluation

How well `POST /api/ask` understands a question, measured on a fixed set of thirty questions
against the deployed site. Production runs Claude Haiku 4.5 (`claude-haiku-4-5`); this set
measures that model only. A comparison with other providers is not part of it yet.

## What is measured

The questions are in [`evals/ask/cases.json`](../../evals/ask/cases.json): 21 in Ukrainian
(including slang and one typed in Russian) and 9 in English. They cover:

- platform and price, local and online co-op, free games and discounts;
- Ukrainian text and voice-over, and games from Ukrainian studios;
- short and long playtime, year ranges, Metacritic and player-rating minimums;
- mood tags (horror, cozy, roguelike, souls-like, detective);
- "like X" questions (Hades, The Witcher 3, Stardew Valley) and a title search;
- an ambiguous question, an off-topic one and a prompt-injection attempt.

Each case lists what a sensible reader expects of the answer:

- `must`: filter fields that must be set, and to what (lists compare as sets, `anyOf` lists acceptable alternatives);
- `mustNot`: fields that must stay unset;
- `tagsAny`: mood tags the cards should be matched on;
- `minItems`, `maxItems`: bounds on the number of cards;
- `mode`: `structured`, `fallback` or `any`;
- `noPromptText`: for the off-topic and injection questions, nothing in the answer may repeat the instructions.

`sort` never travels in `filter`, so the scorer reads it back from `catalogUrl`.

For every answer the scorer ([`scripts/eval/askScore.ts`](../../scripts/eval/askScore.ts)) checks:

| Check            | Passes when                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode             | `mode` is the expected one (`any` always passes)                                                                                              |
| Fields           | every `must` field holds its value and every `mustNot` field is unset                                                                         |
| Tags             | `matchedTags` shares a tag with `tagsAny`                                                                                                     |
| Items            | the card count is within `minItems`…`maxItems`, and never above 8                                                                             |
| Reasons coverage | reported as a share: cards with a reason, out of all cards of structured answers                                                              |
| Reason length    | every reason is at most 80 characters                                                                                                         |
| Plain reasons    | no reason carries a code, a price or a platform (the server's own `plainReason` check)                                                        |
| Interpretation   | the line is in the case's language: share of Cyrillic letters, with capitalised Latin words (game and platform names) left out                |
| Prompt leak      | interpretation, reasons and a model-chosen search share no six-word run with the system prompts, and name no schema field, code or prompt tag |

A case passes when every check that applies to it passes. The totals are:

- the structured rate;
- field accuracy, over all `must` and `mustNot` checks;
- tag accuracy;
- reasons coverage;
- latency p50 and p95, from the server's `tookMs` and from the client's wall time.

`matchedTags` is only filled once the nightly refresh has published the mood-tag facets. Before that, the tag cases fail by design.

## How to run it

```sh
pnpm eval:ask --base-url https://gg-stay.vercel.app
pnpm eval:ask --base-url https://gg-stay.vercel.app --only uk-injection,uk-off-topic
```

- **Pacing:** requests start at least 7 seconds apart, since the endpoint allows 10 a minute per address. A full run takes about 4 minutes.
- **Concurrency:** `--concurrency N` lets several requests be in flight, but they still start 7 seconds apart.
- **Retries:** a 429 is retried once after its `Retry-After`. A request that takes over 30 s is recorded as a timeout.
- **Questions:** each is sent exactly as written.
- **Response cache:** an identical question asked in the last 24 hours comes back from the endpoint's cache. Answers faster than 300 ms are flagged `fromCacheSuspected` (`(cache?)` in the table), and their latency is not the model's.
- **Daily allowance:** each address gets 40 model-backed answers per UTC day, and a full run uses 30. Cached answers do not count, so a repeat within 24 hours costs little but measures the cache. A run with changed questions on the same day falls back once the remaining 10 are spent.
- **Output:** the report goes to `docs/llm/eval-<YYYY-MM-DD>.md` and the raw answers to `docs/llm/runs/eval-<YYYY-MM-DD>.json`. A second run on the same day gets a `-2` suffix, and nothing is overwritten.
- **Exit code:** non-zero when any request got no answer.

The scorer, the report and the runner's pacing have unit tests on recorded answers (`tests/server/eval`). They never touch the network.

## Cost

- **Per run:** each uncached answer is two Haiku 4.5 calls, about $0.007–0.008. A full run of 30 questions costs about **$0.25**.
- **Reading the cost:** it is not visible over HTTP. The endpoint logs `costUsd` on its `[ask]` line for every request. Sum those lines in the Vercel function logs of `/api/ask` for the run's time window, which the report prints, and fill in the report's "Cost (USD)" cell.

## Results

Claude Haiku 4.5 (`claude-haiku-4-5`), 30 cases, run against production.

| Date                             | Structured rate | Field accuracy | Tag accuracy | Reasons coverage | p50 / p95 (tookMs) | Cost    |
| -------------------------------- | --------------- | -------------- | ------------ | ---------------- | ------------------ | ------- |
| [2026-10-02](eval-2026-10-02.md) | 90 % (27/30)    | 95 % (104/110) | 100 % (5/5)  | 78 % (145/185)   | 7.3 / 15.0 s       | ≈ $0.17 |
