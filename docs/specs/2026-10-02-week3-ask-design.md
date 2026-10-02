# GG Stay — Week 3 "Ask: natural-language search" design

Date: 2026-10-02
Status: approved
Scope: the `/ask` page and `POST /api/ask`, its evaluation set and the provider comparison.

## Goal

A player describes what they want in their own words — "кооператив для двох на Switch до 500 грн", "something like Hades but shorter" — and gets a short ranked list of games from the catalog with one line each on why it fits, plus the catalog filter that was understood, which they can open and adjust. If anything fails, they still get a plain search result and are told so.

## Decisions

| Topic             | Decision                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model             | Claude Haiku 4.5 (`claude-haiku-4-5`) through the official `@anthropic-ai/sdk`. About $0.004 per uncached request (two calls).                                                                                                                                                                                                |
| Structured output | `client.messages.parse` with `output_config.format = zodOutputFormat(schema)` (`@anthropic-ai/sdk/helpers/zod`); the parsed result is validated again by our own zod schema before use. No thinking (Haiku 4.5 needs a budget for it; not worth the latency here).                                                            |
| Provider seam     | `LlmProvider { parse(query, locale), rerank(query, candidates, locale) }`. Adapters: Anthropic (production) and OpenRouter (evaluation only, never on the site). Tests use a recorded-response adapter.                                                                                                                       |
| Prompt caching    | Not used: Haiku 4.5's minimum cacheable prefix is 4 096 tokens and the system prompts are well under it. Savings come from the response cache.                                                                                                                                                                                |
| Response cache    | 24 h, keyed by normalised query + locale + index version, in Nitro storage.                                                                                                                                                                                                                                                   |
| Budget protection | The hard cap is the monthly spend limit set in the Anthropic Console (the site cannot write to Redis, so there is no shared counter). In process: per-IP 10/min token bucket, a per-instance daily ceiling of LLM calls, query ≤ 200 characters, `max_tokens` 500 (parse) / 900 (rerank), request timeout 8 s, SDK retries 1. |
| Fallback          | Any error, timeout, refusal, schema failure, missing key or exhausted ceiling → `mode: "fallback"`: the raw query goes to the existing catalog text search; the page says the AI part did not run. Never a 5xx.                                                                                                               |
| Privacy           | Queries are sent to Anthropic; they are not stored with IPs; README states it.                                                                                                                                                                                                                                                |

## Pipeline (`POST /api/ask` `{ q, locale }`)

1. **Parse.** The model maps the query to a `GameFilter` subset the catalog understands — platforms (by family), genres (from the taxonomy list given in the prompt as slugs), game modes, age rating, playtime, year range, Metacritic/rating minimums, `priceMaxUah`, `free`, `onSaleMinPercent`, `ukrainianLocalisation`, `madeInUkraine`, sort — plus `searchText` (title words, if the query names a game or franchise), `similarTo` (a game title, for "like X" queries) and `interpretation`: one sentence in the query's language describing what is being searched. Unknown values are dropped by the schema; the server re-validates every enum and slug against the live taxonomy.
2. **Retrieve.** The filter runs through the existing catalog resolvers (index path or RAWG path exactly as `/games` would choose), up to 40 candidates. `similarTo` resolves the named game and uses its stored similar-games list from the index as candidates (merged with the filter's results when both exist).
3. **Rerank.** The model gets the query and compact candidate cards (id, name, year, genres, tags, modes, price, Ukrainian localisation) and returns an ordered list of up to 12 candidate ids with a reason (≤ 120 characters, query language). Ids not in the candidate set are discarded; if fewer than 3 survive, the retrieval order is used without reasons.
4. **Answer.** `{ mode: "structured" | "fallback", interpretation, filter, catalogUrl, items: [{ card, reason }], tookMs }` — `catalogUrl` is the `/games` URL of the understood filter, built with the existing URL serializer.

## Page `/ask`

A single text field with a visible label and three example queries as buttons; the result shows the interpretation line, the understood filter as the same chips the catalog uses (read-only) with "Відкрити в каталозі", then the cards with their reasons. Loading, empty and fallback states. Linked from the header and from the catalog's empty state. `noindex` for result URLs (`/ask?q=…`); the empty page is indexable. Server-rendered when `q` is in the URL, so results are shareable.

## Evaluation

`evals/ask/cases.json`: 30 queries — Ukrainian and English, simple and compound, prices, localisation, co-op, platforms, "like X", ambiguous and nonsense. Each case lists the filter fields that must (and must not) be set. `pnpm eval:ask --provider anthropic|openrouter` runs live (costs money; owner-triggered), scores structured rate, per-field accuracy, rerank id validity, p50/p95 latency and cost, and writes `docs/llm/eval-<date>.md`. The provider comparison table lives in `docs/llm/README.md`. A recorded run backs a CI test that checks the scorer, not the model.

## Done when

On production, "кооператив для двох на Switch до 500 грн" returns `mode: "structured"` with `LOCAL_COOP`, the Switch platform family and `priceMaxUah: 500`, a Ukrainian interpretation line and ranked cards; removing the key or exhausting the ceiling returns a fallback page, not an error; the evaluation table for both providers is in `docs/llm/README.md`.
