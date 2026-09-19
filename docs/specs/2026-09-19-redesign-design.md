# GG Stay — visual redesign design

Date: 2026-09-19
Status: approved
Scope: a redesign, not a rewrite. Every route, filter, URL parameter, i18n key and existing RAWG request keeps its behaviour. The visual and interaction layer changes, and the GraphQL schema gains a few fields for new surfaces.

## Goal

Make GG Stay look like a product someone chose to build: a cinematic landing page, a cover-first catalog and a game page that share one design system. A visitor should understand within five seconds that this is a game catalog for Ukrainian players, and reach the catalog in one click.

## Decisions already made

| Topic              | Decision                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| Order of work      | Two measured performance steps on the old design first; the redesign gets its own measurements |
| Theme              | Dark by default; colours are CSS variables so a light theme is one extra block later           |
| Palette            | Ink `#0B0C10`, amber accent `#F5A524`, teal signal `#2DD4BF`                                   |
| Type               | Tektur (display), Inter (interface), JetBrains Mono (numerals) — all with Ukrainian Cyrillic   |
| Filters            | Slide-out drawer on every width (left on ≥ 1024 px, bottom sheet below), not a static sidebar  |
| Cover aspect ratio | 16:9 everywhere — RAWG covers are landscape                                                    |
| Pagination         | Numbered pages, server-rendered; no "load more"                                                |
| Dependencies       | `@nuxt/fonts` only; no carousel, animation or 3D libraries                                     |
| Node               | 22, unchanged                                                                                  |

## What does not change

Routes (`/`, `/games`, `/games/[slug]`, `/en/…`), filter semantics, URL format, `useGql`, `useGameFilters`, `filterUrl`, resolvers' existing behaviour, `rawgFetch`, the i18n structure (keys are only added), RAWG attribution in the footer, SSR on every route, ISR on the landing page.

## Design tokens

Tokens live in one place: the `@theme` block of `app/assets/css/main.css`. Components use tokens only — no raw hex values in templates.

| Token         | Value                           | Use                                                       |
| ------------- | ------------------------------- | --------------------------------------------------------- |
| `ink`         | `#0B0C10`                       | Page background                                           |
| `slate-1`     | `#13151B`                       | Cards, drawer, inputs                                     |
| `slate-2`     | `#1A1D25`                       | Hovered and raised surfaces                               |
| `line`        | white at 10 %                   | 1 px borders instead of shadows                           |
| `text`        | `#ECEDEF`                       | Primary text                                              |
| `text-2`      | `#A3A7B3`                       | Secondary text                                            |
| `text-3`      | `#6B7080`                       | Captions, metadata                                        |
| `amber`       | `#F5A524` (on-colour `#1A1200`) | Primary call to action, active filters, focus ring — only |
| `signal`      | `#2DD4BF`                       | Live states only: "now on screen", "coming soon", reset   |
| `score-good`  | `#6EE7A0` on `#12351F`          | Metacritic ≥ 75                                           |
| `score-mixed` | `#FACC15` on `#3A2F05`          | Metacritic 50–74                                          |
| `score-bad`   | `#F87171` on `#3B1212`          | Metacritic < 50                                           |

Spacing scale 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64. Radius 12 px for cards, 999 px for chips and buttons. Blur only on the sticky header and the filter drawer backdrop. Motion 150–250 ms ease-out for hover, apply and open; the only loops are the hero video and the cover ring.

### Typography

- **Tektur** for display: sentence case, large, tight tracking. The logo reads "GG Stay". It is a variable font with a width axis; long Ukrainian headlines use a narrower width (`wdth` 75–85) instead of a smaller size. Used for hero headlines, section titles and the logo — nowhere else.
- **Inter** for all interface text.
- **JetBrains Mono** with tabular figures for every number: years, scores, counts, page numbers.
- Fonts are self-hosted through `@nuxt/fonts`, subset to Latin and Cyrillic, `font-display: swap`.

### Signature

Two things make the site recognisable; everything else stays quiet.

1. **The cover ring** on the landing page — the one expensive motion besides the hero.
2. **Scoreboard numerals** — scores, years and counts are set in mono like a results board. The result count ticks over in 150 ms when a filter changes (no animation under `prefers-reduced-motion`).

## Server additions

All new data goes through the GraphQL BFF; pages never call RAWG.

- `GameCard.screenshots: [Image!]!` — from `short_screenshots`, already in RAWG list responses, so the hover image costs no extra request.
- `GameCard.platformFamilies: [PlatformFamily!]!` — from `parent_platforms`; enum `PC PLAYSTATION XBOX NINTENDO MOBILE OTHER`.
- `Game.screenshots` — filled from `GET /games/{slug}/screenshots` (it resolves to an empty list today).
- `Query.landing: Landing!` with `featured { game, clipUrl }`, `carousel: [GameCard!]!` (24), `newReleases: [GameCard!]!` (8), `topRated: [GameCard!]!` (8), `totalGames: Int!`. Cached for 24 hours.
- **Featured game rule.** RAWG has no minimum-votes filter and `ordering=-rating` over a year returns games with six votes. The resolver takes the 40 most added games of the last 12 months and picks the highest-rated one with at least 100 ratings.
- **Trailers.** RAWG clips (`GET /games/{id}/movies`) exist almost only for older titles; games from the last year have none. `clipUrl` is therefore usually `null` today. The hero is built poster-first with an optional deferred video, so Steam trailers can be added later as a second source without touching the component.
- `Query.searchSuggestions(search: String!): [GameCard!]!` is not needed — the header search reuses `games(filter: { search }, pageSize: 6)`.

Each addition gets fixtures and contract tests like the existing resolvers.

## Components

| Action      | Components                                                                                                                                                                                                                                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add**     | `AppHeader`, `HeaderSearch`, `HeroFeatured`, `HeroVideo` (client-only), `CoverRing` (client-only), `CoverMarquee` (mobile fallback), `WhyCards`, `GameRow`, `MetacriticBadge`, `PlatformIcons`, `ActiveFilterChips`, `FilterDrawer`, `FilterSection`, `SegmentedControl`, `YearRangeSlider`, `ViewToggle`, `ResultCount`, `ScreenshotGallery` |
| **Replace** | `pages/index.vue` (stub → landing), `FilterPanel` (same props and events, new look), `filters/RadioList` → `SegmentedControl`, `filters/YearRange` → `YearRangeSlider`                                                                                                                                                                        |
| **Restyle** | `GameCard`, `GameGrid`, `SortSelect`, `Pagination`, `states/*`, `StoreLinks`, `LocaleSwitcher`, `layouts/default`, `error.vue`, `pages/games/[slug].vue`                                                                                                                                                                                      |

`DESIGN.md` at the repository root documents the tokens and this component list.

## Pages

### Landing `/`

```
┌──────────────────────────────────────┐
│ GG Stay    Каталог    UA/EN    ⌕     │  transparent over the hero, blurred solid bar after scroll
│                                      │
│  ігри, які                           │  100vh; poster renders immediately (this is the LCP element),
│  варто знайти           poster/video │  video loads after idle, muted, looping, with a pause button
│  [Відкрити каталог]  Нові релізи     │
│            зараз на екрані: {title} →│  teal caption linking to the game page
├──────────────────────────────────────┤
│ 900 000+ ігор у каталозі             │  real count from RAWG, mono numerals
│   cover ring: ~24 covers, slow       │  pause on hover, drag/swipe, click → game page
│   infinite rotation, depth fade      │  mobile: marquee; reduced motion: static row
├──────────────────────────────────────┤
│ Чому GG Stay — 3 cards               │  only what is true today: Ukrainian interface,
│ Нові релізи →                        │  deep filters, RAWG data
│ Найкращі за оцінкою гравців →        │  rows reuse GameCard
│ [Відкрити каталог]                   │  same label as the hero button
└──────────────────────────────────────┘
```

- Gradient overlays bottom-to-top and left-to-right keep the headline readable over any poster.
- Without a clip, the poster gets a slow Ken Burns zoom; under `prefers-reduced-motion` it is static and no video loads.
- The pause button is required: moving content longer than five seconds needs a way to stop it.
- The landing stays on ISR; the `landing` query is cached server-side, so a page view does not reach RAWG.

### Catalog `/games`

```
┌──────────────────────────────────────────────────┐
│ GG Stay   [ пошук ігор…                ]   UA/EN │  header search: debounced dropdown with
├──────────────────────────────────────────────────┤  thumbnail, title, year; Enter runs the catalog search
│ [Фільтри (3)]  Знайдено: 12 480   сорт ▾    ▦ ☰ │
│ [RPG ×] [PlayStation 5 ×] [PEGI 16 ×]  Скинути все│  active filter chips
│ ┌────┐┌────┐┌────┐┌────┐┌────┐                   │  5 columns ≥ 1280, 4 ≥ 1024, 3 ≥ 768, 2 below
│ │16:9││    ││    ││    ││    │                   │
│ └─94─┘└────┘└────┘└────┘└────┘                   │
│            ‹  1  2  3  …  40  ›                  │
└──────────────────────────────────────────────────┘
```

- **Filter drawer.** "Фільтри (N)" opens a panel: from the left on ≥ 1024 px, as a bottom sheet below. It is a dialog — focus trap, Escape closes, focus returns to the button, the page behind does not scroll, no slide animation under reduced motion. Choosing an option does not close it; results update underneath immediately; the close button reads "Показати {N} ігор". Sections are collapsible and keep today's headings. Multi-select options are chips; Metacritic, playtime and age rating are segmented controls; years are a dual slider with from/to inputs; developer is a searchable input with suggestions. No per-option counts: RAWG only reports global counts, which would mislead next to active filters.
- **Cards.** Cover first, title, release year, Metacritic badge coloured by band, platform family icons (max five, then "+N"). Hover: cover scales to 1.03, border brightens, the second screenshot fades in. Keyboard focus shows the same state.
- **View toggle.** Grid or list; a preference stored locally, not in the URL.
- **States.** Skeletons shaped like the cards, the empty state with "Скинути фільтри", the error state — restyled, same behaviour.

### Game page `/games/[slug]`

Hero from `background_image` with the same gradient treatment, title in Tektur, a scoreboard row (release date, Metacritic, player rating, platform icons), description, screenshot gallery (keyboard: arrows and Escape, visible focus), stores as buttons, the facts list restyled. No new features. The real HTTP 404 behaviour is unchanged.

## Copy

- One name per action: the button is "Відкрити каталог" everywhere it appears.
- Empty results invite action: "За цими фільтрами ігор немає. Приберіть один або скиньте всі."
- "Чому GG Stay" states only what exists today. Prices and Ukrainian-localisation claims arrive with those features.
- Every new string exists in both locale files; the locale parity test keeps them in sync.

## Accessibility

WCAG AA contrast for text and controls on every surface; visible focus rings in amber; all filters, cards, the ring and the gallery operable by keyboard; covers have alt text from game names; decorative covers in the ring are hidden from assistive technology except the focused one; `prefers-reduced-motion` honoured by the hero, the ring, the drawer, the count ticker and hover transitions.

## Performance guardrails

- The hero poster is the LCP element: explicit dimensions, responsive sizes, high fetch priority; the video element is created after the page is idle.
- Images below the first screen load lazily with responsive sizes.
- `HeroVideo`, `CoverRing` and `ScreenshotGallery` are client-only, lazily loaded chunks.
- No layout shift: every image and the ring reserve their space.
- Lighthouse (mobile) is measured on `/` and `/games` after each page lands and recorded in `docs/perf/`.

## Testing

- Resolver contract tests and fixtures for every schema addition, including the featured-game rule (votes threshold, empty period, no clip).
- Component tests: badge bands, platform family grouping and "+N", chips add/remove/reset, segmented control, year slider bounds, drawer focus trap and Escape, view toggle, header search debounce and keyboard navigation, reduced-motion branches.
- The existing SSR acceptance suite keeps passing; it gains checks for the landing page (headline, call to action, featured caption, rows) and the drawer button.
- The locale parity test covers all new keys.

## Work order

Each step is one pull request with green CI (lint, types, tests, production build) and a preview deployment.

1. Tokens, fonts, `DESIGN.md`, header and footer.
2. Schema additions and the `landing` query.
3. Card, grid, Metacritic badge, platform icons, skeletons.
4. Filter drawer: sections, segmented controls, year slider, chips, result count, view toggle.
5. Header search.
6. Landing: hero.
7. Landing: cover ring, "Чому GG Stay", rows, closing call to action.
8. Game page with the screenshot gallery.
9. Responsive pass at 360 / 768 / 1024 / 1440 / 1920, accessibility pass, Lighthouse on `/` and `/games`.

## Done when

On production: the landing page shows the hero with a featured game and reaches the catalog in one click; the catalog works exactly as before with the new drawer, chips, cards and search; the game page matches the system; both locales are complete; keyboard-only use works end to end; reduced motion removes every loop; Lighthouse results for `/` and `/games` are recorded with no layout shift.
