# Prices from GOG and the Microsoft Store

Date: 2026-10-12. Status: approved by the owner in conversation. Week 4, stage 1 of 2 (stage 2 is a feasibility probe of the Epic Games Store and the PlayStation Store).

## Why

The site shows one price per game: Steam's, in hryvnia, for Ukraine. A game page links to the other stores RAWG knows without saying what they charge. Week 4 adds what they charge — for a buyer in Ukraine, which is the whole point of the site.

## What was ruled out, and on what evidence

An aggregator, IsThereAnyDeal, looked like the short way: one documented API for dozens of PC stores. It was tried with a registered key on 2026-10-12. For `country=UA` and for `country=US` it returned the same 41 prices for seven games, all in US dollars. Its website shows hryvnia for Ukraine, but as a conversion: "UAH 900.24" and "UAH 1,125.42" are $20.00 and $25.00 at 45.01, where Steam's own regular prices for Ukraine are 415 and 499 hryvnia for the same two games (Death's Door, Darkest Dungeon). It has no Ukrainian region. Prices from it would be wrong by half for exactly the stores that matter.

## Sources, as verified on 2026-10-12 (public endpoints, no key)

- **GOG** prices Ukraine in US dollars, with regional prices of its own: one game cost $4.70 for `countryCode=UA` and $14.99 for `countryCode=US` in the same minute. `https://catalog.gog.com/v1/catalog?countryCode=UA&currencyCode=USD&locale=en-US&…` answers a page of products with `id`, `slug`, `productType`, `storeLink` and `price { final, base, discount, finalMoney { amount, currency } }`. A search for "cyberpunk 2077" answered the product whose slug, `cyberpunk_2077`, is the one in RAWG's link `http://www.gog.com/game/cyberpunk_2077`. `api.gog.com/products/prices?ids=…` answered nothing for a game's id.
- **The Microsoft Store** (Xbox and PC) prices Ukraine in hryvnia: `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=…&market=UA&languages=uk-UA,en-US` answered Forza Horizon 5 at 1 540 UAH, and accepts several ids at once. Its product id is the last path segment of RAWG's link (`https://www.microsoft.com/en-us/p/forza-horizon-5-standard-edition/9nkx70bbcdrn`). Two other products (Cyberpunk 2077, The Witcher 3) came back with no purchase price under the filter used — whether they are not sold in that market or priced in another part of the answer is not established.
- **The National Bank of Ukraine** publishes its official rate as open JSON: `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&json`.
- The index holds 1 093 games RAWG lists on GOG and 999 it lists on the Xbox store.

Neither store documents these endpoints for third parties. They can change without notice; everything below must fail to "no price", never to a wrong one.

## What

### 1. Where a game's store references come from

RAWG's `games/{slug}/stores` — the request the job already makes to find a Steam app id — carries every store's link. From it the job keeps, in the permanent mapping beside the app ids:

- the GOG slug: the path segment after `/game/` in a `gog.com` link (with or without a locale segment);
- the Microsoft product id: the twelve-character id that ends the path of a `microsoft.com/…/p/…` or `xbox.com/…/store/…` link.

A link that does not match is no reference; nothing is guessed from a title. New games get their references with their app id, at no extra request. Games resolved before this change are swept: at most `STORE_REF_SWEEP_PER_RUN = 1200` RAWG requests in a full run, by a cursor, until every indexed game RAWG lists on GOG or on the Xbox store has been asked.

Which games those are is in the documents already: `IndexedGame.stores` is RAWG's own list of the stores a game is on, under the site's slugs (`gog`, `xbox-store`), read from the same list the game came from. A game listed on neither store is not asked and needs no mark. "Asked" is remembered store by store: a store the game is listed on with no link the job can read is recorded as such and not asked about again, and a game that gains one of the two stores later is asked then.

### 2. Reading the prices (the refresh job only)

Through transports of their own built from the shared factory — paced, timed out, retried and fixture-backed like the job's others — with a `User-Agent` that names the project and its repository.

- **GOG.** The current price of every referenced slug for `countryCode=UA`, `currencyCode=USD`. The cheapest reliable way is to be established by probing and written down in the code: walking the whole catalog page by page and matching slugs locally (about 250 requests) is the baseline; a narrower query is fine if it is exact. One request per second at most. A walk that fails part-way publishes nothing new for GOG.
- **Microsoft.** Batches of product ids for `market=UA`. The rule that picks the price is to be established on at least thirty products and written down: the standard edition's purchase price for anyone — not a subscriber's price, not a trial — its list price and its regular price. An answer whose currency is not UAH, or with no such price, is no offer.
- **The rate.** NBU's USD rate once per run, kept in the index metadata with its date. When it cannot be read the previous one stands for seven days; after that there is none, and nothing approximate is shown.
- **How often.** GOG and Microsoft are read when their last successful read is more than eleven hours old, whatever the kind of run — twice a day.
- The run summary gains a line for each: how many references, how many prices read, how many failed.

### 3. On the document

`IndexedGame.offers?: IndexedOffer[]` — at most one per store:

```
{ store: 'gog' | 'xbox-store', title?: string, amount: number, regularAmount: number,
  currency: 'USD' | 'UAH', discountPercent: number, url: string, updatedAt: string }
```

Amounts are in minor units. `title` is what the store itself calls the product — GOG's catalog `title`, the Microsoft Store's product title as it answers for Ukraine — as plain text, trimmed, at most 200 characters, and left out when the store gives none. RAWG's link sometimes names another edition than the game it is filed under (a complete season, a "Game of the Year Edition"), and the price is that edition's; the title is how a page can say so. `url` is the store's own address for the product (the catalog's `storeLink`, the Microsoft product page for Ukraine), and must pass the same allow-list as every other outbound link. A store whose read failed keeps its previous offer with its previous `updatedAt`. Steam's price stays where it is.

### 4. GraphQL

```
type Money { amount: Float!  currency: String! }

type StoreOffer {
  …existing fields…
  "What the store itself calls the product the price is for. Null without a price, or when the store gave none."
  title: String
  "A price in another currency, from a store that does not sell in hryvnia."
  foreignPrice: Money
  foreignRegularPrice: Money
  "foreignPrice at the National Bank's rate, rounded to a hryvnia: an estimate, never the charge."
  approxUah: Int
  "True for the one offer that is cheapest, by the rule below."
  cheapest: Boolean!
}

type Game  { …  "The rate approximate prices were made with."  exchangeRate: ExchangeRate }
type ExchangeRate { currency: String!  uah: Float!  date: String! }
type GameCard { …  "The store slug of an offer clearly below Steam's price, or null."  cheaperAt: String }
```

A Microsoft offer fills the existing hryvnia fields (`priceUah`, `regularPriceUah`, `discountPercent`, `updatedAt`); a GOG offer fills `foreignPrice`, `foreignRegularPrice`, `discountPercent`, `updatedAt` and, when there is a rate, `approxUah`. Offers attach to the store rows RAWG's links already produce, by store; a store RAWG does not link is not added.

- **Fresh.** An offer older than 36 hours is not a price: its row is the bare link it is today.
- **The rate's age.** The job drops the rate after seven days without a successful read, but only while it runs: if the job stops, the metadata keeps the last rate it wrote. So the site applies the same rule itself. A rate whose `readAt` is more than seven days old is no rate — no `exchangeRate`, no `approxUah` — and a GOG row then shows its dollar price alone and takes no part in "cheapest", having no hryvnia amount to compare.
- **Cheapest.** Among a game's rows with a price, Steam's included: the lowest hryvnia amount, exact or approximate. An approximate amount wins only when it is at least 5 % below the lowest exact one — a bank's rate is not the National Bank's. Fewer than two priced rows, or a tie, and nothing is marked. Nothing is marked when the lowest price is zero either: «Найдешевше» beside «Безкоштовно» says nothing a visitor cannot see, and the row that charges is not the lowest.
- **`cheaperAt`.** The store of the game's cheapest offer when it is not Steam and is at least 10 % below Steam's current price; null otherwise, and null when Steam has no fresh price.
- Stale index prices follow the existing rule: where Steam's price is stripped, so are these.

### 5. The game page

In the existing "Де купити" block each store row with a price shows it:

- hryvnia stores as today's Steam row does (price, struck regular price, discount chip, "оновлено N годин тому");
- GOG as `$8.99 · ≈ 404 ₴`, the estimate visibly secondary;
- the store's own title for the product is shown under the store's name when it differs from the game's name — so a price for another edition says which edition it is for. "Differs" is decided in one function (`namesAnotherProduct`, `app/utils/storeOffers.ts`): the two are compared after lower-casing, dropping the signs ™ ® ©, collapsing every run of whitespace to one space and trimming. So `Batman™: Arkham Knight` and `METRO EXODUS` are not shown; `… - Game of the Year Edition`, `… Standard Edition` and a Ukrainian title are. The title is plain text from another company's catalog: it is rendered as text only, never as markup. It changes nothing about which row is the cheapest: that stays a rule about prices;
- a discount chip is drawn only for 1 to 99 %, and a struck regular price only when it is above the price — a document can carry a 0 beside a higher regular price, or a 100 beside a price that is not zero, and neither is drawn;
- the cheapest row carries «Найдешевше» / "Cheapest";
- under the block, only when a GOG price is shown: «GOG продає в доларах США. Сума в гривні — приблизна, за курсом НБУ на {date}; банк може списати іншу.» / "GOG charges in US dollars. The hryvnia amount is an estimate at the National Bank of Ukraine's rate of {date}; your bank may charge a different sum."

Rows without a price stay as they are. A partial page (the index-built one) shows the offers it has.

The footer's line of sources names GOG and the Microsoft Store beside RAWG and Steam.

### 6. The catalog card

One short line under the price when `cheaperAt` is set: «Дешевше в GOG» / "Cheaper at GOG" (store names: GOG, Microsoft Store). The catalog's price, its filters, its sorts, the sale shelf and the deal of the day stay Steam's hryvnia price. The `/games` JavaScript budget has 1.8 kB of headroom: the line has to fit it. If it cannot, the task stops and says so; the budget is not raised without the owner.

## Decided while building the game page (2026-10-12)

What sections 4 and 5 left open, as the code now answers it. Each is a decision of the implementation, recorded here so that the card (section 6) and a reviewer read one rule.

- **An estimate that undercuts by less than 5 % marks nothing.** When the lowest amount is approximate and is not 5 % below the lowest exact one, neither row is the cheapest: not the estimate, which has not won clearly, and not the exact price above it, which the page shows beside a lower number. An exact price that is the lowest wins with no margin.
- **A free game is an exact zero.** Nothing at any rate is nothing: a free GOG game is weighed for "cheapest" with or without a rate, is shown as «Безкоштовно», and has no `approxUah`. Where it is the lowest price on the page no row is marked (section 4, ruled on 2026-10-12 after the page was built).
- **Kopecks.** The Microsoft Store charges kopecks during a sale (508.20 ₴). `priceUah` is whole hryvnia, rounded to the nearest, and "cheapest" compares the amounts as the page shows them, so two rows that show the same number tie.
- **A priced row links to the store's own address for the product** (`IndexedOffer.url`), the page the price is charged on, in place of RAWG's link — which, for the Microsoft Store, is the listing for another market. A row without a fresh price keeps RAWG's link.
- **`exchangeRate` is null unless a row on the page carries an `approxUah`.** A page with no estimate on it is told of no rate.
- **The note needs an estimate.** It is shown only while GOG's row shows one. A dollar price with no rate behind it is shown alone and without the note, whose sentence is about the estimate and names the day of a rate.
- **The page built from the index** shows, after Steam, a row for every offer whose store the document lists the game on (`IndexedGame.stores`) — the condition its Steam row already meets, so the two pages of one game never disagree about where it is sold. A fresh offer carries its price; a stale one is a link to the same address. While the index's prices are too old to show, every offer is a link, beside a live Steam price too.
- **The page RAWG answers is not held to the index's staleness.** It shows Steam's index price however old, under its own date; an offer there answers to its own thirty-six hours and nothing else.
- **What this build cannot read is passed over.** An offer for a store or in a currency the build does not know, with an amount that is not a whole non-negative number, a regular amount below the amount, a discount that is not a whole percent, or an address that fails the allow-list, is not shown at all.
- **Where the rows are.** A store with a price is a row in a list; a store without one stays the chip it was, under the list. The rows keep the answer's order.

## Not in this change

The Epic Games Store and the PlayStation Store (probed next); other currencies than USD and UAH; price history; a "best price" filter or sort; prices for games outside the index.

## Constraints

- English only in code, comments, tests, commits and docs; Ukrainian only in `i18n/locales/uk.json`. No AI-assistant attribution anywhere.
- The site makes no request to GOG, Microsoft or the bank: everything is read by the job and served from the index. The site's Redis token stays read-only.
- An approximate amount is always marked ≈, never stored as a hryvnia price, never used by a filter or a sort.
- No secret is needed or added.
- Documents and metadata written before this change must read without error; a site build older than the job's must ignore what it does not know.
- `pnpm typecheck`, `pnpm typecheck:scripts`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `pnpm check:bundle-budget`, `pnpm e2e` pass; codegen is re-run and committed. Tests use fixtures and fake time; no test calls a store.

## After the merge

Manual full runs finish the sweep of store references (two runs at 1 200 a run: 1 597 of the index's 2 552 priced games are listed on GOG or the Xbox store, and the games without a Steam price that are listed there come on top), then a measurement on production: how many indexed games carry a GOG price and a Microsoft price, twenty of each compared by hand with the store's own page for Ukraine, and how many games show another store cheaper than Steam.

## Verified on 2026-10-12

Established with 37 plain GET requests to the three endpoints (20 to GOG, 11 to Microsoft, 6 to the bank), at most one a second, under a `User-Agent` naming this repository; and 18 read-only queries to this site's own GraphQL, for the store links RAWG gives 36 games and for what the index holds. All but six were made before any code was written. Three of those went through the refresh job's own transports and parsers once they existed — one page of the catalog, one batch of the 35 product ids, one day's rate — and read what the probes had: 100 products, 99 of them priced and every `storeLink` the product's own; the same nine prices; the rate of the day asked for. Where a fact contradicts a section above, the fact stands and the code follows it.

### GOG — `https://catalog.gog.com/v1/catalog`

- **No filter by slug or id exists.** `slug=in:…`, `id=in:…` and `ids=in:…` are ignored without an error: the answer is the unfiltered catalog. `query=like:…` is a fuzzy title search, one request a game. So the prices of a set of slugs are read by walking the catalog and matching slugs locally.
- **The whole catalog cannot be walked** — this contradicts "about 250 requests". An answer carries `pages`, `productCount` and `currentlyShownProductCount`, and one query pages through 10 000 products at most: unfiltered, `productCount` was 12 878 and `currentlyShownProductCount` 10 000. With `productType=in:game,pack` — games and their editions, without add-ons and extras — both were 8 250, so that query is walked whole.
- **Page size.** `limit=100` and `limit=101` answered that many products; `limit=200`, `300` and `500` answered HTTP 400 (`"Invalid request parameters"`). The job asks for 100: **83 requests a walk** (page 83 held the last 50; page 84 answered 200 with an empty `products`).
- **Ordering.** `order=asc:title` does not depend on prices or popularity, so a sale starting mid-walk moves nothing. Pages 1 and 2 shared no product. Nothing documents a tie-break, so a walk is checked instead of trusted: every page must repeat the first page's `pages` and `productCount`, no product id or slug may come twice, and the products received must number `productCount`.
- **A product**: `id` (a string of digits), `slug` (`[a-z0-9_]+` in all 743 seen), `productType` (`game`, `pack`, `dlc`, `extras`), `productState`, `storeLink` (`https://www.gog.com/en/game/{slug}`), `price`.
- **`price`**: `{ final: "$5.99", base: "$9.99", discount: "-40%", finalMoney: { amount: "5.99", currency: "USD", discount: "4.00" }, baseMoney: { amount: "9.99", currency: "USD" } }`. Amounts are decimal strings with two places. `discount` is `null` when there is none. Rounding `1 − final/base` to a whole percent reproduced GOG's own label on every discounted product checked.
- **A free game** (Beneath a Steel Sky, GWENT, a demo): the same object with `"0.00"` in both amounts and `discount: null`.
- **A game not yet released**: `productState: "coming-soon"` and `price: null`.
- **`productState`** was `default`, `early-access` or `coming-soon` on all 943 products seen. The first two always had a price and the third never did — the hundred first upcoming products included — so a product has a price exactly when it can be bought, and the price itself is the test.
- **`game` and `pack`.** Each has a slug and a price of its own, and the slug in RAWG's link names one of them exactly: an edition is a `pack` under its own slug (`blair_witch` and `blair_witch_deluxe_edition`). Matching the link's slug is therefore exact for either type.
- **A link RAWG still gives can lead nowhere.** `the_witcher_3_wild_hunt`, the slug of RAWG's link for The Witcher 3, is not in the catalog for Ukraine: only `the_witcher_3_wild_hunt_game_of_the_year_edition` (a `pack`) is. Nothing is guessed from a title, so that game has no GOG price.
- **RAWG's links, as seen** (13 of them): `https://www.gog.com/game/{slug}`, `http://www.gog.com/game/{slug}`, `https://www.gog.com/en/game/{slug}`, `https://www.gog.com/fr/game/{slug}`.

### Microsoft — `https://displaycatalog.mp.microsoft.com/v7.0/products`

Probed with the product ids of 35 real RAWG links: those of the 30 most popular games RAWG lists on the Xbox store, and of five first-party games.

- **How many have a hryvnia price: 9 of the 35 — 5 of the 30 most popular** (LIMBO, Fallout 4, Batman: Arkham Knight, Hollow Knight, Stardew Valley), and four of the five first-party ones. Asked for `market=US`, 28 of the same 35 have a price. So 19 are sold by Microsoft and not in Ukraine, and 7 of RAWG's links name a product sold nowhere any more (the Xbox One edition of Grand Theft Auto V, the first listing of The Witcher 3). **Most games RAWG lists on the Xbox store will have no Microsoft price**, and that is the answer, not a fault.
- That settles what was left open above: Cyberpunk 2077 (`BX3M8L83BBRW`) costs $59.99 in the United States and is not sold in Ukraine; the product RAWG links for The Witcher 3 (`BR765873CQJD`) is sold in neither.
- **Shape.** `Products[]`, each with `ProductId` and `DisplaySkuAvailabilities[]`; each of those a `Sku` (`SkuId`, `SkuType` — `full` or `trial` — and `Properties.IsTrial`, `IsPreOrder`, `IsBundle`) and its `Availabilities[]`. An availability has `Actions`, `Markets`, `Conditions.StartDate`/`EndDate`, `OrderManagementData.Price { CurrencyCode, ListPrice, MSRP }`, and sometimes `RemediationRequired`, `Remediations` and `AffirmationId`.
- **A price anyone can pay** is an availability whose `Actions` include `Purchase`, on a `full` SKU, with no remediation and no affirmation: `CurrencyCode: "UAH"`, `ListPrice` what is charged now, `MSRP` the regular price (Halo Infinite: 508.2 and 1540.0, inside a window that ends on 2026-10-15). Every one of the nine priced products had exactly one.
- **A subscriber's price** is a second `Purchase` availability with `RemediationRequired: true`, `Remediations: [{ Type: "Upsell", BigId: … }]` naming the subscription, and a `ListPrice` of 0. Read as a price it would make every game in Game Pass free.
- **A subscriber's licence** is an availability with `Actions: ["License", …]` and an `AffirmationId`, priced `USD 0.0`.
- **A trial** is a SKU of its own (`SkuType: "trial"`, `IsTrial: true`); where it can be "purchased" its price is 0.
- **Not sold in this market**: no availability with `Purchase` at all. What is left says `CurrencyCode: "USD", ListPrice: 0.0` under `License` or `Details` — a placeholder, never a price.
- **A free game** (Halo Infinite's multiplayer, `9PP5G1F0C2B6`): the availability anyone can pay, with `UAH` and a `ListPrice` of 0.
- **Bundles.** `IsBundle` is true of standard editions too (Forza Horizon 5 Standard Edition bundles its base product), so it says nothing about which edition a product is. A product id is an edition; the one RAWG links is the one priced.
- **`actionFilter=Purchase`** leaves out every product, SKU and availability that cannot be bought, and nothing else: a third of the bytes, and a product that is not sold is simply absent. `fieldsTemplate=Browse` is smaller still but drops the SKU and the remediation, which the rule above needs.
- **Ids a request.** 35, 100 and 190 ids in one request were all answered; no ceiling was found. An id Microsoft does not know is left out without an error. The job sends 100.
- **RAWG's links, as seen** (35 of them, all on `www.microsoft.com`, none on `xbox.com`): `/en-us/p/{name}/{id}` and `/en-us/store/p/{name}/{id}`, and one `/en-us/store/r/{name}/{id}` — a shape the section above does not name. Ids come in lower case and in upper case, usually followed by a query string.

### The National Bank — `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&json`

- **Shape**: a JSON array of one object, `{ "r030": 840, "txt": "…", "rate": 44.9567, "cc": "USD", "exchangedate": "13.10.2026", "special": "N" }` — `txt` is the currency's name in Ukrainian.
- **Without a date it answers the newest rate the bank has set, which in the afternoon is tomorrow's**: asked on 12.10.2026 at 17:06 Kyiv time it answered 44.9567, the rate of 13.10.2026. With `&date=YYYYMMDD` it answers the rate in force on that day and repeats the day in `exchangedate`: asked for `20261012` the same afternoon, it answered 44.8894 for 12.10.2026. The job asks for the day it runs on, in Kyiv, and takes an answer only if it names that day.
- **A weekend or a holiday**: the rate in force that day, under that day's date. Saturday 10.10.2026 and Sunday 11.10.2026 both answered 44.8526; 01.01.2026 answered 42.3532 (with `special: null`). There is no day it answers nothing for.

### RAWG's list of a game's stores, and its links

What the sweep of section 1 relies on: that a game with a GOG or a Microsoft link is a game RAWG lists on that store.

- **How a document's `stores` is filled**: from `stores[].store.id` of the game's entry in RAWG's list, mapped to the site's slugs (`STORE_OPTIONS`: 5 is `gog`, 2 is `xbox-store`), by the same function for the popularity list and for the studios' lists. It is the list the app-id stage has always used to decide which games to ask about Steam.
- **The list and the links are one table.** In RAWG's own record of a game, each store row carries the id of the row `games/{slug}/stores` answers with (the recorded fixtures of The Witcher 3 show both); the links add the URL.
- **They agreed in every case checked, in both directions**: all 30 games RAWG lists on the Xbox store had a Microsoft link; all 13 games found with a GOG link are among the 80 most popular RAWG lists on GOG; the three first-party games found by their slug with a Microsoft link are listed on the Xbox store.
- **How many games that is.** Asked through the index with a price filter, which is the only way the site's GraphQL answers from the index without RAWG: of 2 552 priced games, 1 093 are listed on GOG, 999 on the Xbox store and **1 597 on one or the other** (495 on both). The 1 093 and 999 of "Sources" above are these same counts, so they too are of the games with a Steam price. Games without one that are listed on either store are not in the 1 597; the index holds at most some 850 games without a price, so the sweep is between 1 597 and about 2 400 lookups — two full runs at 1 200 a run — where asking every indexed game was about 3 400.

### What a store calls a product

- **GOG**: `title` on the product (`"The Witcher 3: Wild Hunt — Remastered"` under the slug `the_witcher_3_wild_hunt_game_of_the_year_edition` — a title moves and a slug does not).
- **Microsoft**: `LocalizedProperties[].ProductTitle`. An answer carries one listing a product, in the best match for `languages=uk-UA,en-US`; `Language` says which. All nine products sold in Ukraine answered in English (`en` or `en-us`); of the 35, one — not sold here — answered in Ukrainian. So the title is the one on the product's page for Ukraine, and in practice English.
- **Titles differ from RAWG's names in ways that are not editions**: `LIMBO` for Limbo, `Batman™: Arkham Knight`. And in ways that are: `Hollow Knight: Voidheart Edition`, `Forza Horizon 5 Standard Edition`, `Sea of Thieves: 2026 Edition`.
