# GG Stay — Week 3 "Ask: natural-language search" design

Date: 2026-10-02
Status: approved
Scope: the `/ask` page and `POST /api/ask`, its evaluation set and the provider comparison.

## Goal

A player describes what they want in their own words — "кооператив для двох на Switch до 500 грн", "something like Hades but shorter" — and gets a short ranked list of games from the catalog with one line each on why it fits, plus the catalog filter that was understood, which they can open and adjust. If anything fails, they still get a plain search result and are told so.

## Decisions

| Topic             | Decision                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model             | Claude Haiku 4.5 (`claude-haiku-4-5`) through the official `@anthropic-ai/sdk`. About $0.004 per uncached request (two calls).                                                                                                                                                                                                  |
| Structured output | `client.messages.parse` with `output_config.format = zodOutputFormat(schema)` (`@anthropic-ai/sdk/helpers/zod`); the parsed result is validated again by our own zod schema before use. No thinking (Haiku 4.5 needs a budget for it; not worth the latency here).                                                              |
| Provider seam     | `LlmProvider { parse(query, locale), rerank(query, candidates, locale) }`. Adapters: Anthropic (production) and OpenRouter (evaluation only, never on the site). Tests use a recorded-response adapter.                                                                                                                         |
| Prompt caching    | Not used: Haiku 4.5's minimum cacheable prefix is 4 096 tokens and the system prompts are well under it. Savings come from the response cache.                                                                                                                                                                                  |
| Response cache    | 24 h, keyed by normalised query + locale + index version, in Nitro storage.                                                                                                                                                                                                                                                     |
| Budget protection | The hard cap is the monthly spend limit set in the Anthropic Console (the site cannot write to Redis, so there is no shared counter). In process: per-IP 10/min token bucket, a per-instance daily ceiling of LLM calls, query ≤ 200 characters, `max_tokens` 500 (parse) / 1 600 (rerank), request timeout 8 s, SDK retries 1. |
| Fallback          | Any error, timeout, refusal, schema failure, missing key or exhausted ceiling → `mode: "fallback"`: the raw query goes to the existing catalog text search; the page says the AI part did not run. Never a 5xx.                                                                                                                 |
| Privacy           | Queries are sent to Anthropic; they are not stored with IPs; README states it.                                                                                                                                                                                                                                                  |

## Pipeline (`POST /api/ask` `{ q, locale }`)

1. **Parse.** The model maps the query to a `GameFilter` subset the catalog understands — platforms (by family), genres (from RAWG's genre list given in the prompt as slugs), game modes, age rating, playtime, year range, Metacritic/rating minimums, `priceMaxUah`, `free`, `onSaleMinPercent`, `ukrainianLocalisation`, `madeInUkraine`, sort — plus `tags` (up to three mood or sub-genre tags — "горор" is `horror`, "рогалик" is `roguelike` — from the fixed list in `shared/moodTags.ts`), `searchText` (title words, if the query names a game or franchise), `similarTo` (a game title, for "like X" queries) and `interpretation`: one sentence in the query's language describing what is being searched. Unknown values are dropped by the schema; the server re-validates every enum and slug against the live taxonomy, which is read beside the parse rather than before it.
2. **Retrieve.** The filter runs through the existing catalog resolvers (index path or RAWG path exactly as `/games` would choose), up to 40 candidates. With mood tags, the candidates come from the index's tag facets (`f:tag:{slug}`, filled by the refresh job from every mood tag RAWG gives a game) combined with the filter — games with every tag first, then the most defining one — and the catalog's answer fills up behind them when too few match; the catalog has no tag filter, so the tags stay out of the filter and its link. `similarTo` resolves the named game and uses its stored similar-games list from the index as candidates (merged with the filter's results when both exist).
3. **Rerank.** The model gets the query, its interpretation and compact cards of the 24 most relevant candidates (id, name, year, genres, tags, modes and length, in words — nothing the filter already guaranteed, such as price or localisation) and returns an ordered list of up to 8 candidate ids with a reason (≤ 100 characters, query language) that says something specific about the game for this question, never the filter back; a reason with a price, a platform name or a schema code is dropped. Ids not in the candidate set are discarded; if fewer than 3 survive, or the rerank fails or runs out of time, the retrieval order is used without reasons.
4. **Answer.** `{ mode: "structured" | "fallback", interpretation, filter, catalogUrl, items: [{ card, reason }], ignoredFilters, indexStale, matchedTags, tookMs }` — at most 8 items, in the fallback too; `catalogUrl` is the `/games` URL of the understood filter, built with the existing URL serializer; `ignoredFilters` and `indexStale` are those of the catalog page the cards came from; `matchedTags` names the mood tags the cards were also matched on.

## Page `/ask`

A single text field with a visible label and three example queries as buttons; the result shows the interpretation line, the understood filter as the same chips the catalog uses (read-only) with "Відкрити в каталозі", then the cards with their reasons. Loading, empty and fallback states. Linked from the header and from the catalog's empty state. `noindex` for result URLs (`/ask?q=…`); the empty page is indexable. Server-rendered when `q` is in the URL, so results are shareable.

## Evaluation

`evals/ask/cases.json`: 30 queries — Ukrainian and English, simple and compound, prices, localisation, co-op, platforms, "like X", ambiguous and nonsense. Each case lists the filter fields that must (and must not) be set. `pnpm eval:ask --provider anthropic|openrouter` runs live (costs money; owner-triggered), scores structured rate, per-field accuracy, rerank id validity, p50/p95 latency and cost, and writes `docs/llm/eval-<date>.md`. The provider comparison table lives in `docs/llm/README.md`. A recorded run backs a CI test that checks the scorer, not the model.

## Done when

On production, "кооператив для двох на Switch до 500 грн" returns `mode: "structured"` with `LOCAL_COOP`, the Switch platform family and `priceMaxUah: 500`, a Ukrainian interpretation line and ranked cards; removing the key or exhausting the ceiling returns a fallback page, not an error; the evaluation table for both providers is in `docs/llm/README.md`.
