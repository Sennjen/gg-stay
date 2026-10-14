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

A link that does not match is no reference; nothing is guessed from a title. New games get their references with their app id, at no extra request. Games resolved before this change are swept: at most `STORE_REF_SWEEP_PER_RUN = 1200` RAWG lookups in a full run (a lookup that times out or meets a 5xx is retried once), and for at most twenty minutes of it (`STORE_REF_SWEEP_BUDGET_MS`), by a cursor, until every indexed game RAWG lists on GOG or on the Xbox store has been asked. A sweep that RAWG fails, or that runs out of its time, stops for the night and never fails the run; what it did not ask waits for the next full run.

Which games those are is in the documents already: `IndexedGame.stores` is RAWG's own list of the stores a game is on, under the site's slugs (`gog`, `xbox-store`), read from the same list the game came from. A game listed on neither store is not asked and needs no mark. "Asked" is remembered store by store: a store the game is listed on with no link the job can read is recorded as such and not asked about again, and a game that gains one of the two stores later is asked then.

### 2. Reading the prices (the refresh job only)

Through transports of their own built from the shared factory — paced, timed out, retried and fixture-backed like the job's others — with a `User-Agent` that names the project and its repository.

- **GOG.** The current price of every referenced slug for `countryCode=UA`, `currencyCode=USD`. The cheapest reliable way is to be established by probing and written down in the code: walking the whole catalog page by page and matching slugs locally (about 250 requests) is the baseline; a narrower query is fine if it is exact. One request per second at most. A walk that fails part-way publishes nothing new for GOG.
- **Microsoft.** Batches of product ids for `market=UA`. The rule that picks the price is to be established on at least thirty products and written down: the standard edition's purchase price for anyone — not a subscriber's price, not a trial — its list price and its regular price. An answer whose currency is not UAH, or with no such price, is no offer.
- **The rate.** NBU's USD rate once per run, kept in the index metadata with its date. When it cannot be read the previous one stands for seven days; after that there is none, and nothing approximate is shown.
- **How often.** GOG and Microsoft are read when their last successful read is more than eleven hours old, whatever the kind of run — twice a day.
- **What a read may take away.** Only a read in full removes an offer. A Microsoft read in which a request failed publishes the prices it was given and removes nothing, not even the offer of a product an answered request left out; like a GOG walk that fails, it leaves the store due, so the next run reads again.
- **How far a full read is believed.** When the documents carry at least twenty offers of a store and a read in full would leave fewer than half of them, the read is reported as failed — offers, their dates and the store's stamp stay as they were — with what was seen as the reason (`carried N, the read priced M`). A store that changes the shape of its answer answers every request; read at face value, that would remove every offer in a run that ends green. It is a floor inside the stage, by the reasoning of the publication's own check on Steam's prices, and not a gate: the run publishes as it would have.
- **How far the mapping is believed.** An offer needs a reference, and that rule runs before any read, so the same floor stands one step earlier. When the documents carry at least twenty offers of a store and the mapping names a product for fewer than half of the games carrying them, it is the mapping that looks lost, and it is not believed for that store: no offer of the store is dropped for want of a reference, the store is not read, and its stamp stays where it was (`carried N, the mapping names a product for M of those games`). Under twenty, and from half up, an offer without a reference is dropped as before.
- The run summary gains a line for each: how many references, how many prices read, how many failed. A run whose read of a store failed or was only partial, or whose references for a store look lost, or that ends with no rate at all, also writes a warning annotation, because nothing a store does turns the run red. So does a run in which a mapping that was believed cost a store twenty offers or more: the offers are dropped as the rule has it, the row says how many, and the run does not end without a word.

### 3. On the document

`IndexedGame.offers?: IndexedOffer[]` — at most one per store:

```
{ store: 'gog' | 'xbox-store', title?: string, amount: number, regularAmount: number,
  currency: 'USD' | 'UAH', discountPercent: number, url: string, updatedAt: string }
```

Amounts are in minor units. `discountPercent` is the whole percent `amount` is below `regularAmount`: 0 when they are equal, 100 only when the price is zero, and between 1 and 99 otherwise, however the division rounds. `title` is what the store itself calls the product — GOG's catalog `title`, the Microsoft Store's product title as it answers for Ukraine — as plain text on one line, without characters that cannot be seen, trimmed, at most 200 characters, and left out when the store gives none or gives text with no letter and no digit in it. It is text and is to be printed as text: markup in it is not removed, because it is never interpreted. RAWG's link sometimes names another edition than the game it is filed under (a complete season, a "Game of the Year Edition"), and the price is that edition's; the title is how a page can say so. `url` is the store's own address for the product (the catalog's `storeLink`, the Microsoft product page for Ukraine), and must pass the same allow-list as every other outbound link. A store whose read failed keeps its previous offer with its previous `updatedAt`. Steam's price stays where it is.

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

- **Fresh.** An offer older than 36 hours is not a price: its row is the bare link it is today. Neither is one dated more than five minutes ahead of the request's clock — a wrong date in the future would otherwise never age, and its row would read "updated just now" for as long as the document stood.
- **The rate's age.** The job drops the rate after seven days without a successful read, but only while it runs: if the job stops, the metadata keeps the last rate it wrote. So the site applies the same rule itself. A rate whose `readAt` is more than seven days old is no rate — no `exchangeRate`, no `approxUah` — and a GOG row then shows its dollar price alone, having no hryvnia amount to compare. A rate read more than five minutes ahead of the clock is no rate either: seven days never run out from a moment that has not come.
- **Cheapest.** Among a game's rows with a fresh price, Steam's included: the lowest hryvnia amount, exact or approximate. An approximate amount wins only when it is at least 5 % below the lowest exact one — a bank's rate is not the National Bank's. Fewer than two fresh priced rows, or a tie, and nothing is marked.
- **Cheapest, among fresh prices only.** A row takes part only while its price is fresh by the offers' own clock — read no more than 36 hours ago, and not dated more than five minutes ahead — judged by the `updatedAt` the page shows for it. That holds Steam's row to the offers' rule. The page RAWG answers shows Steam's index price however old, under its age, and the index carries a price forward under its old date when Steam stops answering for a game; such a row is still shown, but it is neither marked nor a yardstick for the others. A live price read at request time is fresh by definition.
- **Cheapest, and a price that cannot be weighed.** While a row shows a fresh price that has no hryvnia amount — a dollar price when there is no rate — no row is marked, whatever the hryvnia rows say: the dollar price may be the lowest on the page, and "cheapest" beside a number that may be lower is the claim an estimate under the 5 % margin is refused for.
- **Cheapest, and a free row.** Nothing is marked when the lowest price is zero either: «Вигідно» beside «Безкоштовно» says nothing a visitor cannot see, and the row that charges is not the lowest.
- **`cheaperAt`.** The store of the game's cheapest offer — by the comparison above, over Steam's price as the index holds it and the offers — when it is not Steam and is at least 10 % below Steam's current price; null otherwise, and null when Steam has no fresh price.
- **Fresh, for a card.** Both prices have to be fresh by that same clock, and by the same function as on a game page (`isFreshAt`, `server/index/offerRules.ts`): read no more than thirty-six hours ago, and not dated more than five minutes ahead of the request's clock. That holds Steam's own price to the offers' rule. The index carries a game's price forward under its old date when Steam stops answering for it, and a card goes on showing that price for as long as the index as a whole is not stale; a price from six weeks ago is not the yardstick for "cheaper", so such a card names no store. Where a card's price is withheld or absent — a stale index, a document without a price — `cheaperAt` is null with it.
- **Free, for a card.** `cheaperAt` is null when Steam's price is zero: nothing is below nothing. A store that gives the game away while Steam charges is named — unlike the mark on a game page, the line stands beside Steam's price alone and says what that price does not.
- Stale index prices follow the existing rule: where Steam's price is stripped, so are these.

### 5. The game page

In the existing "Де купити" block each store row with a price shows it:

- hryvnia stores as today's Steam row does (price, struck regular price, discount chip, "оновлено N годин тому");
- a row is named as the site already names its store — "Xbox Store" for the store whose price comes from the Microsoft Store's catalog (`STORE_OPTIONS`, the store filter's own table);
- GOG as `$8.99 · ≈ 404 ₴`, the estimate visibly secondary;
- the store's own title for the product is shown under the store's name when it differs from the game's name — so a price for another edition says which edition it is for. "Differs" is decided in one function (`namesAnotherProduct`, `app/utils/storeOffers.ts`): the two are compared after lower-casing, dropping the signs ™ ® ©, collapsing every run of whitespace to one space and trimming. So `Batman™: Arkham Knight` and `METRO EXODUS` are not shown; `… - Game of the Year Edition`, `… Standard Edition` and a Ukrainian title are. The title is plain text from another company's catalog: it is rendered as text only, never as markup. It changes nothing about which row is the cheapest: that stays a rule about prices;
- a discount chip is drawn only for 1 to 99 %, and a struck regular price only when it is above the price. The job writes 0, 1 to 99, or 100 for a game given away; a document is whatever the store holds, so one that carries a 0 beside a higher regular price, or a 100 beside a price that is not zero, has neither drawn;
- the cheapest row carries «Вигідно» / "Good deal";
- under the block, only when a GOG price is shown: «GOG продає в доларах США. Сума в гривні приблизна, за курсом НБУ на {date}; банк може списати іншу.» / "GOG charges in US dollars. The hryvnia amount is an estimate at the National Bank of Ukraine's rate of {date}; your bank may charge a different sum."

Rows without a price stay as they are. A partial page (the index-built one) shows the offers it has.

The footer's line of sources names GOG and the Xbox Store beside RAWG and Steam, each as a link to the source's own front page (`https://www.xbox.com` for the last).

**One name for a visitor.** Wherever a visitor reads the store's name — a row of this block, the store filter, the card's line, the footer — it is "Xbox Store". Microsoft's address for a product in Ukraine, `https://www.microsoft.com/uk-ua/p/{name}/{id}`, which a priced row links to, redirects to `https://www.xbox.com/uk-ua/games/store/{name}/{id}` and answers there — opened by hand by the project's coordinator on 2026-10-12, two product addresses, as recorded under "Verified" below; no task of this change requested it: the buyer lands on the Xbox store, and the site already called the store that. "The Microsoft Store" in this document is the company's catalog the refresh job reads, never a name on a page.

### 6. The catalog card

One short line under the price when `cheaperAt` is set: «Дешевше в GOG» / "Cheaper at GOG" (the store's name as the site writes it everywhere else: GOG, Xbox Store — «Дешевше в Xbox Store» / "Cheaper at Xbox Store"). The catalog's price, its filters, its sorts, the sale shelf and the deal of the day stay Steam's hryvnia price. The `/games` JavaScript budget has 1.8 kB of headroom: the line has to fit it. If it cannot, the task stops and says so; the budget is not raised without the owner.

It fits. Measured on a fixture-mode production build with `pnpm check:bundle-budget`: 143 003 bytes before the card's work and 143 030 after, against 144 633 — 27 bytes more, 1 603 left.

## Decided while building the game page (2026-10-12)

What sections 4 and 5 left open, as the code now answers it. Each is a decision of the implementation, recorded here so that the card (section 6) and a reviewer read one rule.

- **An estimate that undercuts by less than 5 % marks nothing.** When the lowest amount is approximate and is not 5 % below the lowest exact one, neither row is the cheapest: not the estimate, which has not won clearly, and not the exact price above it, which the page shows beside a lower number. An exact price that is the lowest wins with no margin.
- **A free game is an exact zero.** Nothing at any rate is nothing: a free GOG game is weighed for "cheapest" with or without a rate, is shown as «Безкоштовно», and has no `approxUah`. Where it is the lowest price on the page no row is marked (section 4, ruled on 2026-10-12 after the page was built).
- **Kopecks.** The Microsoft Store charges kopecks during a sale (508.20 ₴). `priceUah` is whole hryvnia, rounded to the nearest, and "cheapest" compares the amounts as the page shows them, so two rows that show the same number tie. To the nearest and not upwards on purpose: the figure is at most 50 kopecks off, in either direction, and the row links to the store's page, where the exact sum is.
- **A priced row links to the store's own address for the product** (`IndexedOffer.url`), the page the price is charged on, in place of RAWG's link — which, for the Microsoft Store, is the listing for another market. A row without a fresh price keeps RAWG's link.
- **`exchangeRate` is null unless a row on the page carries an `approxUah`.** A page with no estimate on it is told of no rate.
- **The note needs an estimate.** It is shown only while GOG's row shows one. A dollar price with no rate behind it is shown alone and without the note, whose sentence is about the estimate and names the day of a rate.
- **The page built from the index** shows, after Steam, a row for every offer whose store the document lists the game on (`IndexedGame.stores`) — the condition its Steam row already meets, so the two pages of one game never disagree about where it is sold. A fresh offer carries its price; a stale one is a link to the same address. While the index's prices are too old to show, every offer is a link, beside a live Steam price too.
- **The page RAWG answers is not held to the index's staleness.** It shows Steam's index price however old, under its own date; an offer there answers to its own thirty-six hours and nothing else. What an old Steam price loses there is its part in the mark, not its place on the page (section 4, ruled in review).
- **A row is read out in an order of its own.** On screen the estimate sits beside the price it is an estimate of and the struck regular price comes last. A screen reader is given one sentence instead — "−78% $8.99, було $39.99, приблизно 404 ₴" — so that "було" cannot attach to the estimate; the pieces the eye reads are hidden from it.
- **A price's age is counted to the arrival of the answer on the page**: the server's clock for a page the server rendered, carried in the payload so that both renders agree, and the browser's when a game page is opened by navigation or a later answer takes the page over.
- **An amount that is not a price is shown as no price.** A row whose address the allow-list refuses is no row, and an amount below zero or not a number is a store without a price; neither is tidied into something that looks like one.
- **What this build cannot read is passed over.** An offer for a store or in a currency the build does not know, with an amount that is not a whole non-negative number, a regular amount below the amount, a discount that is not a whole percent, or an address that fails the allow-list, is not shown at all.
- **Where the rows are.** A store with a price is a row in a list; a store without one stays the chip it was, under the list. The rows keep the answer's order.

## Decided while building the catalog card (2026-10-12)

What sections 4 and 6 left open, as the code now answers it.

- **Every card carries it, by one function.** `cheaperAtOf` (`server/index/offerRules.ts`) is the rule, and each path that hands out a card asks it: a catalog page the index answers, one RAWG answers once the index's data is attached, the landing's shelves, ring and featured game, a game page's similar games by both of their routes, the deal of the day, and the rows of an `/api/ask` answer. No path is left out. A path that withholds a card's price because the index's prices are stale withholds this with it.
- **Where the comparison names nobody, the card names no store.** `cheaperAt` is the store of the _cheapest_ offer, so it inherits that rule whole: a tie names nobody, and so does an estimate that is not 5 % below a hryvnia price. A game for which GOG's estimate and the Xbox Store's price are both far below Steam's and within 5 % of each other therefore has no line, though either store is cheaper than Steam.
- **The card weighs the index's Steam price, never a live one.** A game page asks Steam for a price older than six hours and marks its cheapest row against the answer, with no ten percent asked of it and without the index's staleness applying. So a card and the page it opens can disagree, in either direction, for as long as the index's Steam price is behind Steam's own.
- **The line carries no figure.** It states no second price and no percentage: a card has no room to say that GOG's hryvnia figure is an estimate, and the game page says it properly.
- **The value is kept with the page.** A catalog page the index answers is cached in the instance's memory for ten minutes with `cheaperAt` as it was worked out, so it can be ten minutes behind the thirty-six hours it measures. An `/api/ask` answer is kept for up to a day under one index version, and the landing's HTML for ten minutes at the edge. No cache that outlives a deployment holds a card, so the shared cache's schema version is unchanged.
- **Where the line is drawn.** On `GameCard` — the catalog's grid and list, the landing's shelves, a game page's similar games — as 12 px secondary text under the price line, absent when there is nothing to say. The rows of the ask page and the mascot's deal of the day receive the field and do not draw it: a row's line is the reason a game fits, and the greeting states one price.
- **The store's name is the store filter's.** The card reads it from `STORE_OPTIONS`, as a game page's row does, and the locale files hold only the sentence around it.

## Not in this change

The Epic Games Store and the PlayStation Store (probed next); other currencies than USD and UAH; price history; a "best price" filter or sort; prices for games outside the index.

## Constraints

- English only in code, comments, tests, commits and docs; Ukrainian only in `i18n/locales/uk.json`. No AI-assistant attribution anywhere.
- The site makes no request to GOG, Microsoft or the bank: everything is read by the job and served from the index. The site's Redis token stays read-only.
- An approximate amount is always marked ≈, never stored as a hryvnia price, never used by a filter or a sort.
- No secret is needed or added.
- Documents and metadata written before this change must read without error; a site build older than the job's must ignore what it does not know.
- `pnpm typecheck`, `pnpm typecheck:scripts`, `pnpm typecheck:tests`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `pnpm check:bundle-budget`, `pnpm e2e` pass; codegen is re-run and committed. Tests use fixtures and fake time; no test calls a store.

## After the merge

Full runs finish the sweep of store references (two runs at 1 200 a run: 1 597 of the index's 2 552 priced games are listed on GOG or the Xbox store, and the games without a Steam price that are listed there come on top), then a measurement on production: how many indexed games carry a GOG price and a Microsoft price, twenty of each compared by hand with the store's own page for Ukraine, and how many games show another store cheaper than Steam. Two things about the order: a full run started by hand is dispatched only after the one before it has ended, because the workflow keeps a single pending run and a scheduled one can take its place; and a store is read only when its last full read is over eleven hours old, so the references the second night's sweep finds get their prices from the next run that finds the stores due. Measure after the first run whose summary shows both stores read once the sweep's row says nothing is left.

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
- **Shape.** `Products[]`, each with `ProductId` and `DisplaySkuAvailabilities[]`; each of those a `Sku` (`SkuId`, `SkuType` — `full` or `trial` — and `Properties.IsTrial`, `IsPreOrder`, `IsBundle`) and its `Availabilities[]`. An availability has `Actions`, `Markets`, `Conditions.StartDate`/`EndDate` (UTC, as `2026-10-15T09:59:59.0000000Z`; a timestamp that names no zone would mean a different moment on every machine, and is not read as one), `OrderManagementData.Price { CurrencyCode, ListPrice, MSRP }`, and sometimes `RemediationRequired`, `Remediations` and `AffirmationId`.
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

### The address of a priced Xbox Store row

Opened by hand by the project's coordinator on 2026-10-12: `https://www.microsoft.com/uk-ua/p/stardew-valley/C3D891Z6TNQM` and `https://www.microsoft.com/uk-ua/p/halo-infinite/9PP5G1F0C2B6` each redirect to `https://www.xbox.com/uk-ua/games/store/{name}/{id}`, answer 200 and show a price in hryvnia. So the address the job builds for a product, `https://www.microsoft.com/uk-ua/p/{name}/{id}`, which a priced row links to in place of RAWG's link, leads to that product's page for Ukraine.

### Decided in review

Found in review after the first delivery. The first three are known and left as they are; the last three say how far a fix goes.

- **A Microsoft request that fails every time is never narrowed down.** If one id ever made the catalog refuse its whole request, the hundred games beside it would never be refreshed and the store's stamp would never move, so every run would repeat all the requests. No wrong price can come of it; the warning a failed read writes is what would show it, and the remedy then is to ask a failed request again in two halves.
- **A store reference record that cannot be read costs the game its offers until the next full run.** Unreadable is read as "never asked", a game with no reference keeps no offer, and only a full run asks RAWG again. The other way round the job would publish a price for a product it can no longer name. The index says so in a warning when it meets such a record.
- **The proof that a GOG walk is whole has one hole.** A product removed before the walk's position and another added after it, both within the same second between two requests, leave the count unchanged and repeat nothing; the product that slid across the page boundary is never seen. It costs one game its GOG price until the next read.
- **A catalog product under a slug that is not a slug is counted and not kept.** Every slug seen is lower-case letters, digits and underscores, and a reference can hold no other. Such a product is counted for the walk's proof and nothing else of it is used — which also keeps a store's raw text out of the run's log, where a line break is a command to the runner.
- **The mapping is held to the same floor as a read, and a store is not read while its mapping is not believed.** If the mapping of store references were lost, every offer would go with it before any read, in a run that asked the stores nothing — the unreadable record above, for every game at once. So the offers stand, with their dates, and the run warns. The store is not asked even about the games the mapping still names: a read of what is left could not count as a read in full, and one that may neither move the stamp nor remove anything would have the job's own fault ask the store on every run. The offers age meanwhile, and a price too old to be called fresh is not shown.
- **The guard lets go at half.** A full run's sweep asks RAWG again about up to 1 200 games before the prices are read, so the night after a loss the mapping may name half of the games again; from then on the rule is the old one, and the offers of the games not yet asked about go until the sweep reaches them, a night later. The run that drops them says so: twenty offers of a store dropped for want of a reference in one run is a warning, and the store's row gives the number. The same warning covers the two halves compounding — half of a store's offers gone by the mapping and half of the rest by a read, each believed on its own. One case still ends without a word: with twenty to thirty-eight offers, a mapping at half can take fewer than twenty and leave the read fewer than twenty to be measured against, so the read is believed whatever it prices.

## Other ways to a product (2026-10-13)

Measured on production on 2026-10-13: 1 162 games have a Microsoft Store product reference and 296 of them a price; 1 204 have a GOG slug and 1 111 a price. RAWG's links go stale. The owner opened Resident Evil Village, one of the unpriced games, in the Ukrainian store: it is on sale for 1 199 ₴ under another product (`9N2S04LGXXH4`) than the one RAWG links (`9MTNPF414F65`, which nobody can buy anywhere). A hand check of twelve more found four on sale under other products (Terraria, Prey, Dishonored 2, and Grand Theft Auto V as "Grand Theft Auto V Enhanced (PC)").

The owner's ruling: the rule of section 1 stays and is extended. Several ways are tried in a fixed order (`scripts/index/storeFallbacks.ts`), and a game has no price at a store only when none of them finds one. None of them asks RAWG anything.

### The ways

**The Microsoft Store.**

1. RAWG's link, as before.
2. **The catalog's relations** (`relation`). A linked product nobody can buy is usually a bundle that was replaced. Read without `actionFilter`, it still names what it was made of (`Parent`), and each of those names every bundle it is in (`Bundle`). Of the parents in the linked product's own group (`Properties.ProductGroupId`), their bundles are read with the purchase filter; a candidate is one in the same group with a price anyone can pay (section 2's rule, unchanged) under the linked product's very title. The cheapest of several; none, and the way finds nothing.
3. **The store's search for the game's name** (`name`, then `edition`). `productFamilies/autosuggest`, games only. A product of `Type: "Game"` whose title is the game's name, or, only when none is, the name followed by edition words (below); listed (`OriginalReleaseDate`) no more than a year before the game's own release; with a price anyone can pay. The cheapest of several; none, and nothing.

A game RAWG lists on the Xbox store without a link the job can read (`microsoft: null`) has the search alone.

**GOG.**

1. RAWG's slug, as before. A slug in the catalog settles the game, priced or not.
2. **The catalog, by the game's name** (`name`, then `edition`), when RAWG's slug is not in the catalog the job has just walked, or RAWG lists the game on GOG without a readable link. A `game` under the name, or, when none is, a `game` or a `pack` (GOG sells editions as packs) under the name and edition words; held to the title ways' guards ("Decided in review" below). The cheapest of those that qualify. No request is added: the catalog is in memory. What a walk found stands while its own product is sold and passes the guards; the catalog is looked through again only when it does not.

Not extended to games RAWG does not list on the store at all: the owner has not ruled on that.

### The comparison of titles

One function for both stores (`scripts/index/titleMatch.ts`). Two titles are equal after: dropping ™ ® ©, Unicode NFKC, lower-casing, every dash a hyphen and every apostrophe the plain one, whitespace collapsed and trimmed. The signs go before NFKC, which would spell ™ as `TM`. Nothing else: `DOOM` is not "DOOM Eternal Standard Edition (PC)".

**An edition's name** (added on the owner's question): the title begins with the game's whole name, the name ends where a word ends, and everything after it is punctuation and words from one list: `standard`, `edition`, `enhanced`, `remastered`, `definitive`, `complete`, `game of the year`, `goty`, `gold`, `ultimate`, `anniversary`, `director's cut`, `pc`, `windows`, `windows 10`, `xbox`, `one`, `series`, `x`, `s`, `x|s`, `for`, `the`, `and`, `&`. A digit or any other word is another product: `Borderlands` does not reach "Borderlands 2", `Prey` does not reach "Prey: Mooncrash", and `deluxe`, `premium`, `bundle`, `pack`, `season pass` and `upgrade` are not on the list. So "DOOM Eternal Standard Edition (PC)" is DOOM Eternal at 895 ₴, and "Grand Theft Auto V Enhanced (PC)" is Grand Theft Auto V at 674,50 ₴.

Decided while building it, each only ever towards finding nothing:

- **A console's letter counts only after the word that makes it one**: `one` after `xbox`; `x`, `s` and `x|s` after `series` (and `s` after `x`). Alone, `X` is a sequel's numeral: "Mortal Kombat X" is not an edition of "Mortal Kombat".
- **At least one word of the list has to name something**: joiners or punctuation alone ("Prey: The", "Prey!") are not an edition.
- **A game the index has no release date for is found under no title**, at either store: there is nothing to hold a product's date against.
- **A product with no date the job can read is not taken**, at either store (ruled in review, below). The Microsoft catalog writes `9998-12-30` where it has none; any year from 9000 on is read as no date.

### What is remembered

- How an offer was found travels with it: `IndexedOffer.via`, one of `relation`, `name`, `edition`, and absent for `link`, so every document written before reads as it always did. The site does not read it; both adapters hand it back untouched, and a value a newer job writes is passed over like any other field.
- What a way found is remembered on the store reference record, beside RAWG's link, which is never overwritten (`IndexedStoreRefs.fallbacks`): at GOG the slug, the way and when; at the Microsoft Store when the ways were last tried (`searchedAt`) and the product they settled on (`id`, a page name made from the store's title for it, the way, when). The record is written before any document: an offer needs a reference, and in the runs between two reads the found product is it.
- A found Microsoft product is priced directly in the normal batched read from then on, beside RAWG's: the link's price whenever it has one, the found product's otherwise. A game every way found nothing for is searched again after thirty days and not before; a later search that finds nothing keeps the product an earlier one found, which is asked about in every read.
- **An offer found by a way is removed only when a read in full finds its own product without a price** (at GOG: when a walk in full finds no product for the game). A read with a failed request removes nothing, as before; when the request about either of a game's two products failed and nothing ahead of it was priced, the game keeps its offer.
- A record RAWG's answer rewrites takes over the old record's finds for each store it still answers about, beside RAWG's links (`IndexedStoreRefs.links`). Every stage that writes a record from RAWG's links builds it with `storeRecordFromLinks`, which carries them (`carryFallbacks`): the sweep and the app-id stage pass the record they replace; `--mode=resolve` asks only about games that have no record, so it has none to carry.

The found product's page is addressed as every Xbox Store row is, `https://www.microsoft.com/uk-ua/p/{name}/{id}`, which redirects to `https://www.xbox.com/uk-UA/games/store/{name}/{id}` (section 5); the name is made from the store's title ("grand-theft-auto-v-enhanced-pc"). The product is found by its id; that the redirect accepts a name RAWG never had has not been opened by hand.

### Limits

- The Microsoft Store's own ways run only in a run that finds the store due (twice a day), and only after a read in full that was believed: not after a partial or failed read, not after one the floor refused, not while the mapping looks lost. They change neither the read's verdict, nor the stamp, nor what the floors measured.
- At most `MICROSOFT_SEARCHES_PER_RUN = 150` games a run, most popular first; some 870 were waiting, so the first pass takes three days. A search is one request, sent once and never retried in the run.
- Relations are read twenty ids a request without the filter: an unfiltered answer is some 60 kB a product (ten were 595 kB), where a hundred filtered ids are under a megabyte. The bundles they lead to, and what searches found, are read a hundred a request with the filter. A product's first eight parents and first forty bundles are followed.
- A failed request leaves its games waiting. A 403 or 429 ends the ways for the run; so do five failed requests, and ten minutes on the job's clock. Each writes a `::warning::`.
- A game whose relations could not be read is not searched for in that run: the order of the ways holds.
- A run adds at most 150 searches, ceil(150/20) relation reads of linked products, one read per 20 parents and per 100 bundles or candidates. Typically about 170 requests, three minutes at one a second, in each due run of the first three days; afterwards only games newly unpriced and those whose thirty days ran out.
- The summary's store rows count each way: `found by: link 296, relation 12, name 60, edition 27; 150 searched for this run in 168 requests, 99 found (relation 12, name 60, edition 27), 570 waiting`.

### Verified on 2026-10-13

With 23 requests to `displaycatalog.mp.microsoft.com`, one a second, under the job's `User-Agent`: 18 by hand, then 5 through the job's own transports and `findMicrosoftProducts`, which found Resident Evil Village (`9N2S04LGXXH4`, 1 199 ₴, by relation) and Prey (`9PBC1QFBW563`, 610 ₴, by name).

- **Without `actionFilter`**, a product nobody can buy is in the answer: `9MTNPF414F65` answered with only `Details` and `License` availabilities in `USD 0.0`, its title, `Properties.ProductGroupId` and `MarketProperties[0].RelatedProducts[]` of `{ RelatedProductId, RelationshipType }`. `fieldsTemplate=Browse` drops the relations and the group; `fieldsTemplate=Details` is the default answer byte for byte. Ten products were 595 130 bytes.
- **The Resident Evil Village chain**: `9MTNPF414F65` has four `Parent`s: the game `9MW7MFV29CMF` and two add-ons in its group VILLAGE, and Resident Evil Re:Verse in another group. Their `Bundle`s are sixteen products; with the filter, three are sold: "Resident Evil Village" (1 199 ₴), its Gold Edition (494,70 ₴ against 1 649 ₴) and a bundle with Resident Evil 7. The way takes the first: same title. The sold product's `OriginalReleaseDate` is 2026-01-20 for a game of 2021.
- **Relations are a newer products' thing**: of ten ids RAWG links, the five beginning `B` or `C` have no `Parent` (Cyberpunk 2077, The Witcher 3 and Grand Theft Auto V have `Bundle`s, and none of their sixteen bundles is sold in Ukraine); of the five beginning `9`, three have parents. Microsoft Flight Simulator: Standard Edition leads to bundles sold only under other titles, so the way finds nothing for it. With the hand check of 34 older products the coordinator made, the way is expected to help the newer ids only. A wider measure needs RAWG's links for the unpriced games, which only production holds.
- **The search** answers `{ "Results": [{ "ProductFamilyName": "Games", "Products": [{ "ProductId", "Type", "Title", … }] }, …], "TotalResultCount" }`, one product a result set, ten at most; a search that finds nothing is `{"Results":[],"TotalResultCount":0}`. Titles come in the listing's language (a Grand Theft Auto V bundle answers in Ukrainian). `Type` is `Game` for an upgrade and a soundtrack as well, and `Durable` for an add-on. A colon in the query works ("DOOM: The Dark Ages" found itself); "The Witcher 3: Wild Hunt" found nothing, the game not being sold in Ukraine.
- **What the searches found**: Terraria (`9NBLGGH186XZ`, 127,50 ₴, no product group), Dishonored 2 (1 000 ₴), Prey (610 ₴; the Digital Deluxe Edition beside it is not taken), Resident Evil Village (two products of that title, one sold), DOOM → only DOOM Eternal, DOOM: The Dark Ages and others, none of them DOOM; DOOM Eternal → "DOOM Eternal Standard Edition (PC)" 895 ₴ and the Deluxe Edition 1 490 ₴; Grand Theft Auto V → two "Grand Theft Auto V Enhanced (PC)" products (one sold, 674,50 ₴ against 1 349 ₴), "Legacy (PC)" and a bundle with a payment card; Stardew Valley → two products of that title; Assassin's Creed Odyssey → only its Ultimate, Gold and Deluxe Editions.
- Fixtures cut to the fields read: `tests/fixtures/microsoft/details.json`, `products-found.json` and `search-*.json`.

### Decided in review (2026-10-14)

Ruled by the owner after the first review of this section.

- **A remake does not lend its product to the game whose name it took.** A name or edition match is refused when the run holds a later indexed game under the same name (compared as titles are), or when the store's product is listed more than twelve years after the game (`RELEASE_LATER_LIMIT_MS`). The longest true re-listing recorded is Grand Theft Auto V Enhanced (PC), eleven and a half years after the game; the remakes that took a name — Dead Space, Resident Evil 4, System Shock, Saints Row, the 2017 Prey for the 2006 one, the 2013 Tomb Raider's Definitive Edition for the 1996 game — are fourteen to twenty-eight years later. A product with no date is refused by these ways at both stores. Both rules are applied again whenever a remembered find is read, at either store, so a find made before them cannot outlive them; a Microsoft find they refuse loses its offer in the next read in full. What costs: a true re-release more than twelve years on has no price by title (Age of Empires: Definitive Edition). What can still slip: a remake within twelve years, when only one of the two games is in the index.
- **The relation way keeps its own rules** and takes a product the catalog calls a `Game`, never an add-on of the group.
- **A GOG find stays until its own product, read in a whole walk, has no price** (or fails the guards). A walk that would pick another product does not remove it.
- **A record rewritten from RAWG's links carries the old record's finds over**, at the sweep and at the app-id stage, for each store the new record still answers about.
- **An index that will not take what the ways found fails nothing.** At the Microsoft Store nothing they found is published or remembered, the read stands, the games stay waiting, and the run warns; at GOG the walk is reported as failed and every offer and the stamp stay as they were.
- **A searched name is written on one line** where the transport logs the request (`oneLine`).
- Left as they are, each for its reason:
  - _The thirty-day cliff._ Games found nowhere in the first pass come due together thirty days later: four due runs at the cap, the load of the first pass and no more.
  - _Found-product addresses._ `microsoft.com/uk-ua/p/{name}/{id}` with a name made from the store's title follows the pattern every Xbox row uses; that the redirect accepts a name RAWG never had is to be opened by hand once.
  - _Odd edition titles._ The list admits a few titles no store uses ("Halo: Gold & Standard"); harmless, since a product still has to be sold under them.
