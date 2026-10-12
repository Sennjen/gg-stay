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

A link that does not match is no reference; nothing is guessed from a title. New games get their references with their app id, at no extra request. Games resolved before this change are swept: at most `STORE_REF_SWEEP_PER_RUN = 1200` RAWG requests in a full run, by a cursor, until every indexed game has been asked once; a game with neither store is remembered as such and not asked again.

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
{ store: 'gog' | 'xbox-store', amount: number, regularAmount: number, currency: 'USD' | 'UAH',
  discountPercent: number, url: string, updatedAt: string }
```

Amounts are in minor units. `url` is the store's own address for the product (the catalog's `storeLink`, the Microsoft product page for Ukraine), and must pass the same allow-list as every other outbound link. A store whose read failed keeps its previous offer with its previous `updatedAt`. Steam's price stays where it is.

### 4. GraphQL

```
type Money { amount: Float!  currency: String! }

type StoreOffer {
  …existing fields…
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
- **Cheapest.** Among a game's rows with a price, Steam's included: the lowest hryvnia amount, exact or approximate. An approximate amount wins only when it is at least 5 % below the lowest exact one — a bank's rate is not the National Bank's. Fewer than two priced rows, or a tie, and nothing is marked.
- **`cheaperAt`.** The store of the game's cheapest offer when it is not Steam and is at least 10 % below Steam's current price; null otherwise, and null when Steam has no fresh price.
- Stale index prices follow the existing rule: where Steam's price is stripped, so are these.

### 5. The game page

In the existing "Де купити" block each store row with a price shows it:

- hryvnia stores as today's Steam row does (price, struck regular price, discount chip, "оновлено N годин тому");
- GOG as `$8.99 · ≈ 404 ₴`, the estimate visibly secondary;
- the cheapest row carries «Найдешевше» / "Cheapest";
- under the block, only when a GOG price is shown: «GOG продає в доларах США. Сума в гривні — приблизна, за курсом НБУ на {date}; банк може списати іншу.» / "GOG charges in US dollars. The hryvnia amount is an estimate at the National Bank of Ukraine's rate of {date}; your bank may charge a different sum."

Rows without a price stay as they are. A partial page (the index-built one) shows the offers it has.

The footer's line of sources names GOG and the Microsoft Store beside RAWG and Steam.

### 6. The catalog card

One short line under the price when `cheaperAt` is set: «Дешевше в GOG» / "Cheaper at GOG" (store names: GOG, Microsoft Store). The catalog's price, its filters, its sorts, the sale shelf and the deal of the day stay Steam's hryvnia price. The `/games` JavaScript budget has 1.8 kB of headroom: the line has to fit it. If it cannot, the task stops and says so; the budget is not raised without the owner.

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

Manual full runs finish the sweep of store references (three runs at 1 200 a run), then a measurement on production: how many indexed games carry a GOG price and a Microsoft price, twenty of each compared by hand with the store's own page for Ukraine, and how many games show another store cheaper than Steam.
