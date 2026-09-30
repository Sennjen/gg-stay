# GG Stay — Week 2B "Made in Ukraine, shelves, similar games" design

Date: 2026-09-30
Status: approved
Scope: the second week 2 cycle. Builds on the week 2A index (`docs/specs/2026-09-20-week2a-price-index-design.md`).

## Goal

A player can find games made in Ukraine, games with Ukrainian localisation and games on sale straight from the landing page, and every game page suggests similar games.

## Decisions

| Topic             | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Made in Ukraine" | The studio was founded in Ukraine and its main development team works (or worked) there. Ukrainian offices of foreign companies and outsourcing houses do not count.                                                                                                                                                                                                                                                                                                                               |
| Studio list       | Data, not code: `data/ukrainian-studios.json` — name, RAWG developer slugs, city, founding year, status, notable games and at least one source per studio. Read through `shared/ukrainianStudios.ts` (`isMadeInUkraine(developerSlugs)`).                                                                                                                                                                                                                                                          |
| Getting the games | The refresh job asks RAWG for each studio's games (`games?developers=<slug>`, most added first, up to 2 pages per slug) on a full run, marks them `madeInUkraine`, and adds those outside the top 3 000 to the index so they get prices and localisation too. About 25–60 extra RAWG requests per night.                                                                                                                                                                                           |
| Game page flag    | Computed from the game's own RAWG developers with `isMadeInUkraine`, so it is right for games outside the index too.                                                                                                                                                                                                                                                                                                                                                                               |
| Landing shelves   | Five shelves replace the two old rows: "Зроблено в Україні", "Українською", "Зі знижкою", "Найкращі цього року", "Очікувані". The first three come from the index (made in Ukraine / Ukrainian text or audio / discount ≥ 30 %, all by popularity); the last two from RAWG over the whole catalog (this calendar year by rating; future release dates by how many people added them). Each shelf has "Усі ігри" linking to the matching catalog URL. A shelf with fewer than 4 games is not shown. |
| Similar games     | From the index: games sharing at least one genre with the current game, most popular first, excluding the game itself and, when possible, preferring games that share a platform family; 8 cards. Hidden when fewer than 4.                                                                                                                                                                                                                                                                        |
| Badge             | "Зроблено в Україні" as visible text on the game page (scoreboard) and a compact visible label on cards (no icon-only mark).                                                                                                                                                                                                                                                                                                                                                                       |
| Filter            | "Зроблено в Україні" toggle in the filter drawer, `madeInUkraine=1` in the URL, served from the index like the other index filters (so the "top 3 000" note applies, now "3 000 найпопулярніших ігор і всі українські").                                                                                                                                                                                                                                                                           |

## GraphQL

```graphql
enum ShelfId { MADE_IN_UKRAINE UKRAINIAN ON_SALE BEST_THIS_YEAR UPCOMING }
type Shelf { id: ShelfId!  games: [GameCard!]! }
type Landing { featured: FeaturedGame  carousel: [GameCard!]!  shelves: [Shelf!]!  totalGames: Int! }
type GamePage { …  similar: [GameCard!]! }
```

`newReleases` and `topRated` are removed from `Landing`. The catalog URL each shelf links to is built in the interface from the shelf id (`shared/shelves.ts` holds that mapping, so resolver and interface agree on the filter behind each shelf).

## Failure behaviour

Index unavailable or prices stale → the index shelves are omitted (not shown empty), the RAWG shelves still render, similar games are hidden; nothing fails. Existing deadline and circuit apply. The landing stays ISR (600 s).

## Work order

1. Data file, shared lookup, this design (one PR).
2. Refresh job: the studios stage; game-page flag from developers.
3. Schema, landing shelves, similar games, badge, filter, interface.

Steps 2 and 3 run in parallel on top of step 1.
