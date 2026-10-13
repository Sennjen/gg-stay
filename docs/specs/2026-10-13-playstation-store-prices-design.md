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

## Verified on 2026-10-13

Established with 28 plain GET requests to Sony, never under eleven seconds apart, under the `User-Agent` above, with no cookie sent and no redirect followed: 12 to the catalog endpoint, 14 to the storefront's, 2 to the store's product pages. All answered; none was a 403, a 429 or a challenge page. The last two were made through the refresh job's own transport and parsers once they existed, and read what the first 26 had. Every answer set an Akamai cookie, and none was sent back. The answers are recorded, cut to the fields the job reads, in `tests/fixtures/playstation`. Where a fact contradicts a section above, the fact stands and the code follows it.

### The catalog — `m.np.playstation.com/api/catalog/v2/titles/{titleId}/concepts`

- **Confirmed as described**, for eight PlayStation 4 titles and one PlayStation 5 title (`PPSA01721_00`, which answers the same concept as Grand Theft Auto V's PlayStation 4 titles). The answer is a list of one entry. An American title id asked with `country=UA` comes back in a concept whose `titleIds` lists it beside the European ones, in every case; the job takes a concept only from an entry that names the title it asked about.
- **A title Sony has no concept for** answers `[{ "titleIds": [asked], "country": "UA", "language": "uk", "revisionIds": {}, "errorCode": 3166081 }]` under a 200. A PlayStation 3 title (`NPUB31077_00`) and a PlayStation 4 title id Sony never issued (`CUSA99999_00`) answer the same, to the byte. Only that code is read as "no concept", which is remembered for good; any other error is a request that failed.
- **A concept can have no default product**, and the catalog then leaves `defaultProduct` out: Grand Theft Auto: San Andreas (nothing of it on sale), and Stardew Valley (one product on sale, and none put first).
- `storeDisplayClassification` of the default products met: `FULL_GAME` (Terraria, God of War, Cyberpunk 2077, Metro Exodus), `GAME_BUNDLE` (Grand Theft Auto Online, the default product of Grand Theft Auto V), `PREMIUM_EDITION` (The Witcher 3's complete edition). `type` was `GAME.FULL_GAME` for four of them and `GAME.BUNDLE` for two: Grand Theft Auto Online, and God of War — which is the game. `edition.type` was `STANDARD` on four, Grand Theft Auto Online among them, `PREMIUM` on The Witcher 3 and `OTHER` on Terraria. So the one product in the sample that is another product than the game is also the only `GAME_BUNDLE`, and the only one whose `storeSubClassification` is `BUNDLE` rather than `NA`; one case is not a rule, an edition of the game is set apart by the same field in another way, and none of it is in the price answer, which is the one read every day. No rule is built on it.

### The storefront — `web.np.playstation.com/api/graphql/v1/op`, `conceptRetrieveForCtasWithPrice`

- **Confirmed as described**, with `Content-Type: application/json` and the hash above, for eleven concepts.
- **A hash the storefront has not registered** is refused with HTTP 400 and `{ "message": "Query … not whitelisted" }`. That is what a change of the query on Sony's side will look like: every price request fails, the stage ends on the third, and the run says so.
- **A concept the Ukrainian store does not have** answers HTTP 200 with `data.conceptRetrieve: null` and `errors` whose `extensions.errorCode` is `3166081`, the catalog's own code (`statusCode: 404`). It is read as an answer, "no product": the offer is removed. Any other `errors` is a request that failed.
- **`webctas` types met**: `ADD_TO_CART`, `DOWNLOAD`, `DOWNLOAD_TRIAL`, `UPSELL_PS_PLUS_GAME_CATALOG`, `UPSELL_PS_PLUS_TRIAL`, `UPSELL_GTA_PLUS_FREE`. Every priced product had exactly one entry that is a price anyone can pay. Every other entry differs from it in at least three of the fields the rule reads (`type`, `applicability`, `isTiedToSubscription`, `serviceBranding`, `qualifications`, `meta.upSellService`), except the trial, which differs in `type` alone: Terraria's `DOWNLOAD_TRIAL` is free, applicable, tied to nothing and comes first in the list.
- **A free game** is one `DOWNLOAD` entry at 0 against 0 (Warframe; Life Is Strange Episode 1).
- **A sale** is `discountedValue` under `basePriceValue` with `endTime` as epoch milliseconds in a string (`"1792623540000"`, 2026-10-21T22:59:00Z, on all three sales met); `endTime` is `null` on every entry that is not a sale.
- **Two of the three sales met are listed for the buyers of an experiment.** Red Dead Redemption 2 (649,75 against 2 599,00) and Metro Exodus (94,90 against 949,00), both of campaign `PROMO-PROD-00019584`, carry two `qualifications` of type `USER_IN_EXPERIMENT` on their `ADD_TO_CART` entry, which is otherwise `APPLICABLE` and untied; Terraria's sale, of another campaign, carries none. The store's own page showed the first of them 649,75 to a visitor who was not signed in on 2026-10-12. Section 2 says a price anyone can pay "has no qualification", and its "What was ruled out" names that very price as what the store sold the game for: the two cannot both hold. **The rule stands as written**: such an entry is no price, not its discounted amount and not its regular one, so those two games have no PlayStation Store price while the campaign runs. It is the choice that cannot show a wrong price, and it costs prices exactly when they are lowest. Whether `USER_IN_EXPERIMENT` should count as "anyone" is the owner's to rule on; it is one condition in `purchasePriceOf` and one recorded fixture.
- **A default product that is `null` while the concept lists a product** (Stardew Valley) is read as section 2 has it: no product, no price. No other product is chosen.
- **Names come in the store's language**: The Witcher 3's default product is named in Ukrainian. Most are in English.
- Of the eleven concepts asked about, seven give a price by the rule (five paid, two free); two have no default product; two are the sales above.
- A member's discounted price for PlayStation Plus was not met, again; how one is written is still not established, and the rule refuses everything it would plausibly be marked with (`isTiedToSubscription`, `isExclusive`, a branding other than `NONE`, a qualification).

### The product's page — `https://store.playstation.com/uk-ua/product/{id}`

Answered 200 for the two default products tried (God of War, `EP9000-CUSA07412_00-0000000GODOFWARN`; The Witcher 3's complete edition, `EP4497-PPSA04021_00-0000000000GOTY11`), each naming the product and the price the storefront gave for it: 649 and 1 649 UAH. Product ids met have the shape `XX0000-XXXX00000_00-` and sixteen capital letters and digits; an id of any other shape is no address, and a price without an address is no offer.

## Decided while building the job (2026-10-13)

- **The pause is counted from the end of a request**, its answer or its failure, to the moment the next one leaves. Two requests are never closer than ten seconds however long Sony took over the first, and 225 of them at half a second each are a little under the forty minutes.
- **The forty minutes are counted from the run's first request to Sony**, and no request leaves once they have passed. The transport is built with the rest of the job's dependencies, an hour before its stage in a full run.
- **A refusal is a 403, a 429, a redirect, a page, or a success that is not JSON.** Both endpoints answer in JSON even to say no, so anything else is somebody in front of them answering instead. Redirects are not followed: a hop is a request nobody counted. Any other failure — a timeout, the network, another status, an answer that cannot be read — counts towards the three in a row; an answer that is read, whatever it says, starts the count again.
- **The transport holds every limit**, and is the only thing in the repository that can reach Sony: the pause, the cap, the budget, the stops and the order of requests are inside it, and the stage only asks while it will take a question.
- **A game Sony answers about with no price is remembered as such** (`unpricedAt` on the game's reference, beside `conceptId`). Section 2 orders the prices by the date of the offer, and a game with no price has no offer to date: without the mark it would be asked about first by every run, five times a day, for ever. With it, it is asked once a day like any other. It is written when the answer comes, also when the floor then refuses to remove the offer, so a run that is not believed does not have its games asked about again six hours later.
- **The floor holds back removals and nothing else.** The prices a run read are published whatever becomes of its removals; what is weighed is the games that carried an offer and were answered about in this run.
- **The games most asked for first.** Among games never read, and among titles waiting for a concept, the more popular game is asked about first, so the pages most opened are the first to have a price.
- **Sixty mappings a run count the requests that failed too**, and a title whose request failed is not written as "no concept": that is said only when Sony said it.
- **A title that belongs to several concepts has no concept.** Choosing among them would be a guess. None was met.
- **What Sony said about a title survives a record rewritten from RAWG's links**, for as long as the link still names that title; the app-id stage reads the records of the games it is about to ask about for that, one request on a night that has any.
- **References are written ten at a time**, and what is left when the stage ends: a run that dies loses at most the batch it had not written.
- **A run whose lock will not renew stops asking Sony.** It cannot publish, so nothing more is asked on its behalf.
- **The pages do not use this store's offers yet.** The job publishes them from this change on; what a page shows of them is section 4, and until that is built a page keeps its own list of the stores whose offers it uses (`PAGE_OFFER_STORES`), which is the two it had. A PlayStation Store row is the link RAWG gave, as before.
- **Known and left as it is: a game whose request fails every time stays the oldest.** It is asked about first by every run, and three such games at the head of the queue would end every run's stage on its third request. The warning that writes is what would show it; nothing of the kind was met.
