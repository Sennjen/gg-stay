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
- **A game is asked about once a day**: a game Sony was asked anything about less than twenty hours ago is not asked about again (`PLAYSTATION_REREAD_AFTER_MS`), whatever came of the request. The moment of the asking is written to the game's reference before the request leaves (`askedAt`), so the rule holds for a run that does not publish and for a game Sony fails for every time. Prices are read by the four prices runs a day, so the day's reads are spread over them in portions.
- **No retry.** A request that fails is not repeated, in that run or in the next: the game takes its turn again a day later.
- **The first refusal ends the stage for that run, and silences every run for a day**: an HTTP 403 or 429, or a challenge page, and nothing more is asked by that run, nor by any run of any kind for twenty-four hours after it (`PLAYSTATION_SILENCE_MS`). The moment is kept beside the job's cursors, outside the published version, so a run that publishes nothing is remembered all the same. Three failures of any other kind in a row end the stage for that run too, and silence nobody.
- **A run that cannot publish asks nothing.** A run whose version is going to be refused publication asks Sony nothing, and neither does a dry run, on the live network or off it: it keeps nothing and holds no lock.
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
playstation?: { titleId: string, conceptId?: number | null, askedAt?: string } | null
```

`titleId` comes from RAWG's link, by the existing sweep and by the app-id stage (a game listed on the PlayStation Store whose record says nothing about it is asked about, as for any store). `conceptId` comes from Sony's first endpoint: a number when the title has a concept in the Ukrainian store, `null` when Sony answered that it has none (asked again after thirty days, `PLAYSTATION_NO_CONCEPT_KEPT_MS`: a title can come to the store later), absent while Sony has not answered. `askedAt` is when Sony was last asked anything about the game, a mapping or a price, whatever came of it.

### 2. Reading (inside the limits above)

One stage, after the other stores' stage. Each kind of run asks one kind of question, so that neither can take the other's requests:

1. **Prices, in the prices runs** (four a day), for the games that have a `conceptId`: the concept asked about longest ago first and one never asked about before any other, skipping a concept any of whose games was asked about in the last twenty hours. One concept is one request, and its answer serves every game that maps to it.
2. **Mappings, in the nightly full run**, right after the sweep that finds the titles: for the games that have a `titleId` and no answer yet, and for those answered "no concept" thirty days ago or more; never asked before any other, then the one asked longest ago; at most two hundred a night (`PLAYSTATION_MAPPINGS_PER_RUN`), at the same ten seconds: about thirty-five minutes, under the transport's forty minutes and 225 requests, which bound a night whatever that number says. Two games that link one title are one request. Mapping a thousand titles takes five nights. A title the night mapped is first priced by the prices run twenty hours on; that it waits about a day for its first price is accepted as it is, one date for both questions being what keeps a game from being asked about twice inside twenty hours.
3. **A languages run asks nothing.**

**How much that is.** Four prices runs at 225 requests are 900 price reads a day. With more concepts than that a game is read less than once a day: every C/900 days for C concepts. The site calls an offer of this store a price for forty-eight hours (section 4), which tolerates that up to about 1 700 concepts. The summary row shows how old the oldest published price is, and a prices run that ends with a price the site still shows read more than forty hours ago writes a `::warning::` with the number of concepts against the 900: eight hours, one more prices run, before that price stops being shown.

**How long a run takes.** A prices run: what it took — a minute and a half, and about five more when GOG and the Microsoft Store are due — and up to forty minutes of this stage: about forty-five minutes at the most. The nightly run: about an hour, up to twenty minutes of the sweep while it has work, and two hundred mapping requests, thirty-five minutes, forty at the most: just under two hours on its longest night, against a ceiling of 150 minutes. A languages run: as before.

The stage renews the writer's lock as it goes; forty minutes of waiting must not cost the run its lock.

**The price anyone can pay** is the `webctas` entry of the concept's default product whose `type` is `ADD_TO_CART`, whose price is in `UAH`, is not tied to a subscription (`isTiedToSubscription` false, no PlayStation Plus branding as its condition), is `APPLICABLE`, and has no qualification. `discountedValue` is what is charged now and `basePriceValue` the regular price, both in kopecks. A game that is free for everybody is the entry of type `DOWNLOAD` that is free and not tied to a subscription; a trial, a subscriber's catalogue entry or an upsell is never a price. Anything else is no price. The implementer confirms each of these shapes on real answers and names in the appendix every entry type met.

**A discount for the buyers of an experiment is read at its regular price.** A sale can be listed with `qualifications` of type `USER_IN_EXPERIMENT` (see "Verified"). Such an entry is taken at its `basePriceValue`, as a price with no discount and no `saleEndsAt`, on four conditions and no others: every one of its qualifications is `USER_IN_EXPERIMENT`; the product has no unqualified purchase entry, to which this is only a fallback (two candidates that disagree are no price); amount and regular amount are both the base and the discount is 0; and the base is above zero. A qualification of any other kind is still no price. The row then shows the dearer of two sums the store may charge and promises no discount.

**An entry that cannot be read is a failure, not "no price".** A purchase entry that has lost a field the rule reads, or changed the kind of one, or is in another currency than the hryvnia that was asked for, is this job not understanding Sony any more: the request is counted as failed, the offer stays, and three in a row end the stage.

**A sale's end** travels with the offer: `endTime` of the entry, as `saleEndsAt`. A price read once a day would otherwise outlive its sale by up to two days.

**The product, not the game.** A concept's default product is not always the game RAWG filed the link under: for Grand Theft Auto V it is the standalone Grand Theft Auto Online. No rule by identifiers was found to tell them apart, and nothing is matched by title. So the offer always carries the product's own name, and the page always shows it, so that a visitor sees which product a price is for when it is compared with the others (section 4).

### 3. On the document

`OFFER_STORES` gains `'playstation-store'`. Its offer is the existing shape — hryvnia, kopecks, `title` (the default product's name, through the same sanitiser), `url` — plus one optional field for any store:

```
saleEndsAt?: string   // ISO; after it the offer's price is its regular price
```

`url` is the product's page in the Ukrainian store, `https://store.playstation.com/uk-ua/product/{defaultProduct.id}`, built from an id that has passed a strict pattern, and checked by `safeExternalUrl` like every other.

What a read does to an offer, one concept at a time, since one request is one concept:

- answered with a price anyone can pay → today's offer, for every game of the concept;
- answered, and there is no such price or no product → the offer is removed;
- failed, refused, or not asked this run → the offer and its `updatedAt` stay.

**The floor.** A change of shape on Sony's side must not empty the store in a green run: when a run has asked about at least twenty games that carried an offer and more than half of those answers would remove it, none of that run's removals is applied, the stage is reported as failed with the two numbers, and a `::warning::` says so. The same when a run has asked about at least twenty games and not one answer is a price: in the store's first days no game carries an offer for the first rule to weigh. And the same under "no concept", the one answer that stands for a month: when a night has heard about at least twenty titles and more than half are said to have none, none of those answers is remembered, and the titles are asked about again another night. The mapping guard of the other stores applies to this one as it stands.

The summary gains a row for the store in every kind of run (references, mapped, with no concept, waiting; prices read or titles answered about; removed, failed; offers and how old the oldest is; requests; why it stopped — or that a run of this kind does not ask, is going to be refused publication, or keeps silent after a refusal, with the moment of the refusal and the moment the silence ends), and every way the stage ends early writes a `::warning::` — a refusal, three failures in a row, a floor — except running out of its requests or its time, which is the design. A refusal is warned of once, by the run it came to; the runs that keep silent after it say so in their row.

### 4. On the site

- **Freshness.** This store's offer is a price for forty-eight hours, not thirty-six: it is read once a day, and one missed day must not blank it. Freshness becomes a rule per store; the other stores keep thirty-six.
- **After a sale's end** an offer with `saleEndsAt` in the past is served at its regular price, with no discount.
- **The row** in "Де купити" is a hryvnia row like Steam's and the Xbox Store's. For this store the product's title is always shown under the store's name, whether or not it differs from the game's name.
- **Every store is compared, this one included.** A PlayStation Store row is weighed like any hryvnia row: it can carry the mark, it is a yardstick for the others, and a card's `cheaperAt` can name it ("Дешевше в PlayStation Store" / "Cheaper at PlayStation Store"). Every other rule of the mark and of `cheaperAt` holds as for the other stores: each row weighed while fresh by its own store's span, the 5 % an estimate has to win by, nothing marked when the lowest price is free, the 10 % for a card. _The first version of this section said the opposite: never marked, never weighed, never named. The owner decided on 2026-10-14 to compare every store, console stores included, and to call the mark «Вигідно» / "Good deal" instead of «Найдешевше» / "Cheapest": the mark says a price is the best on the page, not that the products are the same._
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

The sweep of RAWG's links for the games listed on the PlayStation Store takes one or two nights. **It costs RAWG at least 1 186 requests** — one for each indexed game RAWG lists on the store: the 1 186 that have a Steam price, and the listed games without one on top — at up to 1 200 a night. It starts with the first nightly run after the merge and nothing in the code holds it back, so **the merge has to fall inside a fresh RAWG quota period**; the branch is not merged before 2026-10-18.

The mapping follows at two hundred titles a night: some eight hundred titles are four nights, and each night's titles get their first price the next day. Then a measurement on production: how many games carry a PlayStation Store price, twenty compared by hand with the store's page for Ukraine, how often the product is not the game, how many concepts there are against the 900 price reads a day and how old the oldest price in the summary row is, and what the runs' summaries say about refusals.

## Verified on 2026-10-13

Established with 28 plain GET requests to Sony, under the `User-Agent` above, with no cookie sent and no redirect followed: 12 to the catalog endpoint, 14 to the storefront's, 2 to the store's product pages. The first 26 were never under eleven seconds apart from start to start; the last two were made through the refresh job's own transport and parsers once they existed, left ten seconds after the first of them had ended (10.4 seconds from start to start), and read what the first 26 had. All answered; none was a 403, a 429 or a challenge page. Every answer set an Akamai cookie, and none was sent back. The answers are recorded, cut to the fields the job reads, in `tests/fixtures/playstation`. Where a fact contradicts a section above, the fact stands and the code follows it.

### The catalog — `m.np.playstation.com/api/catalog/v2/titles/{titleId}/concepts`

- **Confirmed as described**, for eight PlayStation 4 titles and one PlayStation 5 title (`PPSA01721_00`, which answers the same concept as Grand Theft Auto V's PlayStation 4 titles). The answer is a list of one entry. An American title id asked with `country=UA` comes back in a concept whose `titleIds` lists it beside the European ones, in every case; the job takes a concept only from an entry that names the title it asked about.
- **A title Sony has no concept for** answers `[{ "titleIds": [asked], "country": "UA", "language": "uk", "revisionIds": {}, "errorCode": 3166081 }]` under a 200. A PlayStation 3 title (`NPUB31077_00`) and a PlayStation 4 title id Sony never issued (`CUSA99999_00`) answer the same, to the byte. Only that code is read as "no concept", which is remembered for thirty days; any other error is a request that failed.
- **A concept can have no default product**, and the catalog then leaves `defaultProduct` out: Grand Theft Auto: San Andreas (nothing of it on sale), and Stardew Valley (one product on sale, and none put first).
- `storeDisplayClassification` of the default products met: `FULL_GAME` (Terraria, God of War, Cyberpunk 2077, Metro Exodus), `GAME_BUNDLE` (Grand Theft Auto Online, the default product of Grand Theft Auto V), `PREMIUM_EDITION` (The Witcher 3's complete edition). `type` was `GAME.FULL_GAME` for four of them and `GAME.BUNDLE` for two: Grand Theft Auto Online, and God of War — which is the game. `edition.type` was `STANDARD` on four, Grand Theft Auto Online among them, `PREMIUM` on The Witcher 3 and `OTHER` on Terraria. So the one product in the sample that is another product than the game is also the only `GAME_BUNDLE`, and the only one whose `storeSubClassification` is `BUNDLE` rather than `NA`; one case is not a rule, an edition of the game is set apart by the same field in another way, and none of it is in the price answer, which is the one read every day. No rule is built on it.

### The storefront — `web.np.playstation.com/api/graphql/v1/op`, `conceptRetrieveForCtasWithPrice`

- **Confirmed as described**, with `Content-Type: application/json` and the hash above, for eleven concepts.
- **A hash the storefront has not registered** is refused with HTTP 400 and `{ "message": "Query … not whitelisted" }`. That is what a change of the query on Sony's side will look like: every price request fails, the stage ends on the third, and the run says so.
- **A concept the Ukrainian store does not have** answers HTTP 200 with `data.conceptRetrieve: null` and `errors` whose `extensions.errorCode` is `3166081`, the catalog's own code (`statusCode: 404`). It is read as an answer, "no product": the offer is removed. Any other `errors` is a request that failed.
- **`webctas` types met**: `ADD_TO_CART`, `DOWNLOAD`, `DOWNLOAD_TRIAL`, `UPSELL_PS_PLUS_GAME_CATALOG`, `UPSELL_PS_PLUS_TRIAL`, `UPSELL_GTA_PLUS_FREE`. Every priced product had exactly one entry that is a price anyone can pay. Every other entry differs from it in at least three of the fields the rule reads (`type`, `applicability`, `isTiedToSubscription`, `serviceBranding`, `qualifications`, `meta.upSellService`), except the trial, which differs in `type` alone: Terraria's `DOWNLOAD_TRIAL` is free, applicable, tied to nothing and comes first in the list.
- **A free game** is one `DOWNLOAD` entry at 0 against 0 (Warframe; Life Is Strange Episode 1).
- **A sale** is `discountedValue` under `basePriceValue` with `endTime` as epoch milliseconds in a string (`"1792623540000"`, 2026-10-21T22:59:00Z, on all three sales met); `endTime` is `null` on every entry that is not a sale.
- **Two of the three sales met are listed for the buyers of an experiment.** Red Dead Redemption 2 (649,75 against 2 599,00) and Metro Exodus (94,90 against 949,00), both of campaign `PROMO-PROD-00019584`, carry two `qualifications` of type `USER_IN_EXPERIMENT` on their `ADD_TO_CART` entry, which is otherwise `APPLICABLE` and untied; Terraria's sale, of another campaign, carries none. The store's own page showed the first of them 649,75 to a visitor who was not signed in on 2026-10-12. Section 2 says a price anyone can pay "has no qualification", and its "What was ruled out" names that very price as what the store sold the game for: the two cannot both hold. **Ruled in review: such an entry is read at its base price**, with no discount and no end of a sale, on the four conditions section 2 now states. On both entries the base is a whole sum equal to the base of the same product's subscription entry, and Red Dead Redemption 2's is the 2 599 ₴ the catalog gives as its regular price; that the base is unqualified is all the same an inference from two answers of one campaign, since `qualifications` hangs on the whole price. What it shows is 2 599 ₴ while the store may be charging a quarter of that: it never promises a discount, it keeps a large campaign from removing offers or tripping the floor, and a price that is too high never wins the mark.
- **A default product that is `null` while the concept lists a product** (Stardew Valley) is read as section 2 has it: no product, no price. No other product is chosen.
- **Names come in the store's language**: The Witcher 3's default product is named in Ukrainian. Most are in English.
- Of the eleven concepts asked about, nine give a price by the rule: five paid and two free as they stand, and the two sales above at their regular price. Two have no default product.
- A member's discounted price for PlayStation Plus was not met, again; how one is written is still not established, and the rule refuses everything it would plausibly be marked with (`isTiedToSubscription`, `isExclusive`, a branding other than `NONE`, a qualification).

### The product's page — `https://store.playstation.com/uk-ua/product/{id}`

Answered 200 for the two default products tried (God of War, `EP9000-CUSA07412_00-0000000GODOFWARN`; The Witcher 3's complete edition, `EP4497-PPSA04021_00-0000000000GOTY11`), each naming the product and the price the storefront gave for it: 649 and 1 649 UAH. Product ids met have the shape `XX0000-XXXX00000_00-` and sixteen capital letters and digits; an id of any other shape is no address, and a price without an address is no offer.

## Decided while building the job (2026-10-13)

- **The pause is counted from the end of a request**, its answer or its failure, to the moment the next one leaves. Two requests are never closer than ten seconds however long Sony took over the first, and 225 of them at half a second each are a little under the forty minutes.
- **The forty minutes are counted from the run's first request to Sony**, and no request leaves once they have passed. The transport is built with the rest of the job's dependencies, an hour before its stage in a full run.
- **A refusal is a 403, a 429, a redirect, a page, or a success that is not JSON.** Both endpoints answer in JSON even to say no, so anything else is somebody in front of them answering instead. Redirects are not followed: a hop is a request nobody counted. Any other failure — a timeout, the network, another status, an answer that cannot be read — counts towards the three in a row; an answer that is read, whatever it says, starts the count again.
- **The transport holds every limit**, and a real run reaches Sony through nothing else: the pause, the cap, the budget, the stops and the order of requests are inside it, and the stage only asks while it will take a question. There is one transport a clock, so one a process, however often it is asked for.
- **The floor holds back removals and nothing else.** The prices a run read are published whatever becomes of its removals; what is weighed is the games that carried an offer and were answered about in this run.
- **The games most asked for first.** Among games never asked about, and among titles waiting for a concept, the more popular game is asked about first, so the pages most opened are the first to have a price.
- **Sixty mappings a night count the requests that failed too**, and a title whose request failed is not written as "no concept": that is said only when Sony said it.
- **A title that belongs to several concepts has no concept.** Choosing among them would be a guess. None was met. One concept named twice is one concept.
- **What Sony said about a title survives a record rewritten from RAWG's links**, for as long as the link still names that title; the app-id stage reads the records of the games it is about to ask about for that, one request on a night that has any.
- **A run whose lock will not renew stops asking Sony.** It cannot publish, so nothing more is asked on its behalf.
- **The pages do not use this store's offers yet.** The job publishes them from this change on; what a page shows of them is section 4, and until that is built a page keeps its own list of the stores whose offers it uses (`PAGE_OFFER_STORES`), which is the two it had. A PlayStation Store row is the link RAWG gave, as before.

## Decided in review (2026-10-13)

The review of the job found one way a condition could be broken in production and one outside it, and two places where the design's own words did not hold. What was ruled, each of it now in the sections above:

- **Every request is dated on the reference before it leaves** (`askedAt`), a price request and a mapping request alike, whatever comes of it. The first design dated a read by its offer, in a document that is published forty minutes later or not at all: a run that asked and then did not publish left every game as due as it had been, and the next run asked Sony about the same games six hours later. And a game whose request failed kept the oldest date, so failing games gathered at the head of the queue, and three of them there ended every run's stage on its third request. With the date on the reference the twenty hours hold for both, a failing game keeps its place in the rotation, and an index that will not take the date stops the asking at once. It is one date for both questions, so a title mapped at night is first priced by the prices run twenty hours on, not by the next one. `unpricedAt`, which said the same for "no price" alone, is gone.
- **A run that is going to be refused publication asks nothing.** Whether a version will be refused is a function of its games and the published metadata, neither of which the stage changes, so it is known before the stage starts.
- **A dry run is never handed the way to Sony.** It reads the recorded answers whatever its other transports do: it remembers nothing afterwards and holds no lock, and beside the scheduled run it would be a second caller on a pause of its own.
- **One concept is asked once a run**, and its answer serves every game that maps to it; two games that link one title are mapped once.
- **"No concept" has a floor under it, and an end.** It was remembered for good on one answer, with nothing to weigh it against: a catalog that answered "none" for everything would have marked sixty titles a night conceptless in green runs. Now a night's answers are weighed together, and one that is kept is asked again after thirty days.
- **Prices in the prices runs, mappings in the nightly run, nothing in a languages run.** One ration shared in the order "prices, then mappings" is a ration the prices take whole once the concepts reach a day's capacity, after which no new title is ever mapped. It also takes the forty minutes out of the one run that is near its ceiling. The price of it: the store's prices are read four times a day and not five, and mapping is two hundred titles a night and not three hundred a day.
- **A discount for an experiment's buyers is read at its base price**, on four conditions (section 2). Before the ruling it was no price at all.
- **A run that asks about twenty games and prices none is not believed**, and a purchase entry that cannot be read is a failed request and not "no price".
- **The pause is kept by a clock that only goes forward**, and by the clock rather than by the timer: a request does not leave on the word of a sleep that came back early. A body that does not arrive is a failure, not a refusal.

Ruled after that, the same day:

- **Two hundred titles a night**, where the first ruling had sixty: sixty took over two weeks to map the catalog, and two hundred take five nights. The night stays inside what the transport gives any run; a slow Sony ends it at the forty minutes with fewer titles.
- **After a refusal, a day of silence.** The first design had "until the next run", which is a knock on the door every six hours for as long as nobody reads the warning. The moment of the refusal is written to one key beside the job's cursors (`job:cursor:playstation-refused`) as soon as it comes, and every run that would ask Sony looks there first: inside twenty-four hours it asks nothing and says in its row when the refusal was and when the silence ends; after that it removes the key and asks. A moment that cannot be read, or lies ahead of the clock, is taken for a refusal just now and written back. The run that asks again is in practice the one after the same hour the next day, because the refusal came some requests into its run: about thirty hours with no read. The four runs that follow then catch up, oldest first, and each price is about forty-eight hours old when its turn comes: on the day after a refusal some rows lose their price for some hours, and the warning above says so. That is what a day of silence costs, and it is taken.
- **A warning before prices stop being shown**: section 2, "How much that is".
- **The date is written before the request, up to one pause before it leaves, and a game can be dated and then not asked about when the transport stops between the two**: accepted as it is, a day's wait for at most one concept a run being the price of never asking without a date.

Known and left as they are:

- **The lock keeper knows a renewal that threw, not a lock that was taken.** The adapter returns without a word when the lock is somebody else's. Not reachable while the stage renews every minute.
- **What Node's `fetch` adds.** `accept-language: *`, `accept-encoding` and `sec-fetch-mode: cors` on every request, and one resend by itself on an HTTP 421, which the transport neither counts nor paces. Closing both means leaving `fetch` for `node:https`.
- **A run that hears about fewer than twenty games carrying an offer removes what it hears**, unless it priced nothing at all.

## Decided while building the pages (2026-10-14)

- **One span of freshness per store, in one place.** `offerFreshForMs` in `server/index/offerRules.ts` answers forty-eight hours for this store (`PLAYSTATION_OFFER_FRESH_FOR_MS`) and thirty-six for every other. The refresh job's warning before prices stop being shown reads that constant (`PLAYSTATION_PRICE_SHOWN_MS` is it, not a copy). Steam's price and every comparison keep the thirty-six hours: this store's longer span never meets a comparison.
- **A sale's end is applied wherever an offer is read for a visitor** (`offerAt`): the page RAWG answers, the page built from the index and a card alike, for any store that names an end. An end that cannot be read is taken as passed: a discount whose end is unknown is not one a page can stand behind.
- **"Never compared" was built and then removed.** It was a list of stores (`UNCOMPARED_OFFER_STORES`) left out of the mark and of a card's line. On 2026-10-14 the owner ruled that every store is compared (section 4), and the list went: a PlayStation Store row is weighed while fresh by its own forty-eight hours (`isFreshFor`), where Steam's and the other stores' rows keep thirty-six.
- **The title is always shown for this store**, the game's own name included (`shownTitle`, `app/utils/storeOffers.ts`), and nothing else about the row is new: a hryvnia row like the Xbox Store's.
- **An experiment's discount read at its base price** (section 2) needs nothing on the page: the job writes it as a price with no discount, and the row's link is the product's page, where the store's own figure is.
- **The development seed** gives Stardew Valley's offer a made-up product title of two hundred characters, the most an offer's title may have, as the row's worst case on a phone.
