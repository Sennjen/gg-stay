# What the PlayStation Store charges in Ukraine, read slowly

Date: 2026-10-13. Status: approved by the owner in conversation. Week 4, stage 2. It builds on [the other stores' prices](2026-10-12-other-store-prices-design.md), whose terms (an offer, a store reference, freshness, the read floor) are used here as defined there.

## Why

A game page links to the PlayStation Store for the games RAWG lists there and says nothing about the price. The store has a storefront for Ukraine that charges in hryvnia, at regional prices: a $19.99 game is 619 or 649 ₴, where the National Bank's rate would make it 899 ₴.

## What was ruled out, and on what evidence

- **The Epic Games Store.** Its price endpoint (`store.epicgames.com/graphql`) answers a desktop and refuses a GitHub runner: HTTP 403 with a Cloudflare challenge, twice, from two runner addresses, on 2026-10-12. The job runs on runners, and a challenge is not something this project gets around. Epic is not read.
- **The price in the mapping answer alone** (below). It is the regular price; a sale is there only as raw offer rules. Red Dead Redemption 2 read 2 599 ₴ there while the store sold it for 649,75 ₴.
- **A bulk read.** The storefront accepts only its own registered operations, one concept a request; its listing operation carries a hundred concepts and no prices.

## The constraint that shapes everything: the read is small and slow

Sony's endpoints are undocumented, and its website terms restrict automated access. The owner has accepted that for a non-commercial site, on these conditions, which are requirements and not tuning:

- **Ten seconds between two requests to Sony**, of either kind, whatever came of the first (`PLAYSTATION_PAUSE_MS = 10_000`).
- **At most 225 requests to Sony in one run** (`PLAYSTATION_REQUESTS_PER_RUN`), and at most forty minutes of them (`PLAYSTATION_BUDGET_MS`); whichever comes first ends the stage.
- **A game's price is read once a day**: a game whose offer was read less than twenty hours ago is not asked about (`PLAYSTATION_REREAD_AFTER_MS`). The job runs five times a day, so the day's reads are spread over its runs in portions.
- **No retry.** A request that fails is not repeated in that run; the game is simply among the oldest next time.
- **The first refusal ends the stage for that run**: an HTTP 403 or 429, or a challenge page, and nothing more is asked until the next run. So do three failures of any other kind in a row.
- The requests say who they are: `User-Agent: gg-stay-index-refresh/1.0 (+https://github.com/Sennjen/gg-stay)`, as the job's other transports do. Nothing is done to look like a browser, and no cookie is sent.
- The site itself never calls Sony. It serves what the job published.

## Sources, as verified on 2026-10-12 (public endpoints, no key)

Both answered a desktop and a GitHub runner.

- **A title's concept**: `GET https://m.np.playstation.com/api/catalog/v2/titles/{titleId}/concepts?country=UA&language=uk&age=99`. A US title id asked with `country=UA` answers the concept with its Ukrainian products; the concept id is the same in every region. A title the current store does not carry (every PS3 and Vita one) answers an entry with an `errorCode` and no `id`.
- **A concept's price**: `GET https://web.np.playstation.com/api/graphql/v1/op?operationName=conceptRetrieveForCtasWithPrice&variables={"conceptId":"…"}&extensions={"persistedQuery":{"version":1,"sha256Hash":"eab9d873f90d4ad98fd55f07b6a0a606e6b3925f2d03b70477234b79c1df30b5"}}` with the headers `x-psn-store-locale-override: uk-UA` and `Content-Type: application/json` (without the second the server refuses the request as a possible forgery). It answers `data.conceptRetrieve.defaultProduct` with `id`, `name`, `npTitleId` and `webctas[]`, each a way to get the product with its `price`.

The implementer verifies both again before relying on them, records real answers as fixtures, and writes what was found in a "Verified" appendix here — within a budget of sixty requests to Sony, ten seconds apart.

## What

### 1. Which games, and their references

A game is a candidate when RAWG lists it on `playstation-store` and its link there is `store.playstation.com/{locale}/product/{productId}` with a product id of the shape `XX0000-XXXX00000_00-…`. The title id is the middle part (`UP1004-CUSA00419_00-GTAVDIGITALDOWNL` gives `CUSA00419_00`). Only PS4 and PS5 titles are taken — a title id that begins `CUSA` or `PPSA`; any other link is "listed there, asked, no reference" (`null`), exactly as an unreadable GOG or Microsoft link is.

The reference lives in the game's store-reference record beside the other two:

```
playstation?: { titleId: string, conceptId?: number | null } | null
```

`titleId` comes from RAWG's link, by the existing sweep and by the app-id stage (a game listed on the PlayStation Store whose record says nothing about it is asked about, as for any store). `conceptId` comes from Sony's first endpoint: a number when the title has a concept in the Ukrainian store, `null` when Sony answered that it has none (not asked again), absent while not yet asked.

### 2. Reading (every run of the job, inside the limits above)

One stage, after the other stores' stage, spends the run's requests in this order:

1. **Prices**, for the games that have a `conceptId`, oldest offer first and those never read before any other, skipping a game read in the last twenty hours.
2. **Mappings**, for the games that have a `titleId` and no `conceptId` yet, at most sixty a run (`PLAYSTATION_MAPPINGS_PER_RUN`) and only with what the run's 225 leave — except that a run with no price to read at all spends its requests on mappings up to the same sixty. Mapping a thousand games takes three or four days. That is intended.

The stage renews the writer's lock as it goes; forty minutes of waiting must not cost the run its lock.

**The price anyone can pay** is the `webctas` entry of the concept's default product whose `type` is `ADD_TO_CART`, whose price is in `UAH`, is not tied to a subscription (`isTiedToSubscription` false, no PlayStation Plus branding as its condition), is `APPLICABLE`, and has no qualification. `discountedValue` is what is charged now and `basePriceValue` the regular price, both in kopecks. A game that is free for everybody is the entry of type `DOWNLOAD` that is free and not tied to a subscription; a trial, a subscriber's catalogue entry or an upsell is never a price. Anything else is no price. The implementer confirms each of these shapes on real answers and names in the appendix every entry type met.

**A sale's end** travels with the offer: `endTime` of the entry, as `saleEndsAt`. A price read once a day would otherwise outlive its sale by up to two days.

**The product, not the game.** A concept's default product is not always the game RAWG filed the link under: for Grand Theft Auto V it is the standalone Grand Theft Auto Online. No rule by identifiers was found to tell them apart, and nothing is matched by title. So the offer always carries the product's own name, the page always shows it, and this store takes no part in any comparison (section 4).

### 3. On the document

`OFFER_STORES` gains `'playstation-store'`. Its offer is the existing shape — hryvnia, kopecks, `title` (the default product's name, through the same sanitiser), `url` — plus one optional field for any store:

```
saleEndsAt?: string   // ISO; after it the offer's price is its regular price
```

`url` is the product's page in the Ukrainian store, `https://store.playstation.com/uk-ua/product/{defaultProduct.id}`, built from an id that has passed a strict pattern, and checked by `safeExternalUrl` like every other.

What a read does to an offer, one game at a time, since one request is one game:

- answered with a price anyone can pay → today's offer;
- answered, and there is no such price or no product → the offer is removed;
- failed, refused, or not asked this run → the offer and its `updatedAt` stay.

**The floor.** A change of shape on Sony's side must not empty the store in a green run: when a run has asked about at least twenty games that carried an offer and more than half of those answers would remove it, none of that run's removals is applied, the stage is reported as failed with the two numbers, and a `::warning::` says so. The mapping guard of the other stores applies to this one as it stands.

The summary gains a row for the store (references, mapped, prices read, removed, failed, requests, why it stopped), and every way the stage ends early writes a `::warning::` — a refusal, three failures in a row, the floor — except running out of its requests or its time, which is the design.

### 4. On the site

- **Freshness.** This store's offer is a price for forty-eight hours, not thirty-six: it is read once a day, and one missed day must not blank it. Freshness becomes a rule per store; the other stores keep thirty-six.
- **After a sale's end** an offer with `saleEndsAt` in the past is served at its regular price, with no discount.
- **The row** in "Де купити" is a hryvnia row like Steam's and the Xbox Store's. For this store the product's title is always shown under the store's name, whether or not it differs from the game's name.
- **No comparison.** A PlayStation Store row is never marked «Найдешевше» and is not weighed when another row is; a card's `cheaperAt` never names it and is not affected by it. It is a console's store, and its product may be another thing than the game.
- The footer's sources line names the PlayStation Store. README ("Known gaps", the status table, the architecture note on what the job reads) and DESIGN.md say what is true.

The `/games` first-load JavaScript must not grow for this: no card shows anything new.

## Not in this change

The Epic Games Store; PlayStation Plus prices; choosing a product other than the concept's default; PS3 and Vita titles; a line on a card; any read from the site.

## Constraints

- English only in code, comments, tests, commits and docs; Ukrainian only in `i18n/locales/uk.json`; no em dash in the site's copy. No AI-assistant attribution anywhere.
- The limits in "The constraint that shapes everything" are tested: the pause with an injected clock and sleep, the caps, the twenty hours, the stop on refusal, no retry.
- A failure of Sony's endpoints cannot fail a run, block publication or trip a publication gate, and cannot remove an offer.
- Documents and metadata written before this change read without error; a site build older than the job's ignores what it does not know.
- No secret is needed or added. No test calls Sony; fixtures are recorded answers cut to the fields read.
- `pnpm typecheck`, `pnpm typecheck:scripts`, `pnpm typecheck:tests`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `pnpm check:bundle-budget`, `pnpm e2e` pass; codegen is re-run and committed if the schema changes.

## After the merge

The sweep of RAWG's links for the games listed on the PlayStation Store takes one or two nights, the mapping three or four days after that. Then a measurement on production: how many games carry a PlayStation Store price, twenty compared by hand with the store's page for Ukraine, how often the product is not the game, and what the runs' summaries say about refusals.
