# GG Stay — design system

This is the visual system for GG Stay: a dark, cinematic game catalog for
Ukrainian players. It documents the tokens, typography, spacing and
accessibility rules the components are built on, and tracks which components
have been restyled so far.

## Tokens

All tokens are CSS variables defined in the `@theme` block of
`app/assets/css/main.css`. Components use tokens only — no raw hex values in
templates. Tailwind ships its own `slate` and `amber` palettes, so the tokens
below use distinct names to avoid confusion between "Tailwind slate" and "our
surface colour".

| Token                    | Value        | Tailwind utilities                          | Use                                                          |
| ------------------------ | ------------ | ------------------------------------------- | ------------------------------------------------------------ |
| `--color-ink`            | `#0B0C10`    | `bg-ink`, `text-ink`, `border-ink`          | Page background                                              |
| `--color-surface-1`      | `#13151B`    | `bg-surface-1`, `border-surface-1`          | Cards, drawer, inputs                                        |
| `--color-surface-2`      | `#1A1D25`    | `bg-surface-2`, `border-surface-2`          | Hovered and raised surfaces                                  |
| `--color-line`           | white at 10% | `border-line`, `bg-line`                    | 1 px borders instead of shadows                              |
| `--color-fg`             | `#ECEDEF`    | `text-fg`, `border-fg`                      | Primary text                                                 |
| `--color-fg-2`           | `#A3A7B3`    | `text-fg-2`                                 | Secondary text                                               |
| `--color-fg-3`           | `#6B7080`    | `text-fg-3`                                 | Captions, metadata — non-essential, ≥ 14 px only (see below) |
| `--color-accent`         | `#F5A524`    | `bg-accent`, `text-accent`, `border-accent` | Primary call to action, active filters, focus ring — only    |
| `--color-on-accent`      | `#1A1200`    | `text-on-accent`                            | Text/icons placed on an accent background                    |
| `--color-signal`         | `#2DD4BF`    | `text-signal`, `border-signal`, `bg-signal` | Live states only: "now on screen", "coming soon", reset      |
| `--color-score-good`     | `#6EE7A0`    | `text-score-good`, `bg-score-good`          | Metacritic ≥ 75 (foreground)                                 |
| `--color-score-good-bg`  | `#12351F`    | `bg-score-good-bg`                          | Metacritic ≥ 75 (chip background)                            |
| `--color-score-mixed`    | `#FACC15`    | `text-score-mixed`, `bg-score-mixed`        | Metacritic 50–74 (foreground)                                |
| `--color-score-mixed-bg` | `#3A2F05`    | `bg-score-mixed-bg`                         | Metacritic 50–74 (chip background)                           |
| `--color-score-bad`      | `#F87171`    | `text-score-bad`, `bg-score-bad`            | Metacritic < 50 (foreground)                                 |
| `--color-score-bad-bg`   | `#3B1212`    | `bg-score-bad-bg`                           | Metacritic < 50 (chip background)                            |
| `--color-sale`           | `#B6F36A`    | `bg-sale`, `text-sale`, `border-sale`       | Discount/sale chip background (PR 6) — price reductions only |
| `--color-on-sale`        | `#0B0C10`    | `text-on-sale`                              | Text/icons placed on a sale-chip background                  |

Score-band chips (`MetacriticBadge`) land in PR 3 with the restyled card; this
PR only reserves the tokens.

### Radius

- `--radius-card` = 12px → `rounded-card`, used for cards, panels and dialogs.
- `--radius-chip` = 999px → `rounded-chip`, used for chips and buttons (same
  value as Tailwind's built-in `rounded-full`, named separately so intent is
  clear in templates).

### Layout

- `--header-h` = 4rem → `h-[var(--header-h)]`, the fixed height of `AppHeader`'s bar; any section
  that must run underneath the sticky transparent header (the landing hero) offsets itself by
  this token instead of measuring the header in JS.

### Spacing

The spacing scale is Tailwind's default 4 px step, used at 4 / 8 / 12 / 16 /
24 / 32 / 48 / 64 (`gap-1`…`gap-16`, `p-1`…`p-16`, etc.). No custom spacing
tokens were added — the default scale already lands on every value the design
calls for.

### Motion

Hover, apply and open transitions run 150–250 ms ease-out. The only loops are
the hero video, the cover ring and the mascot's idle, peek and thinking moods
(see "Gege, the mascot"). A global
`prefers-reduced-motion: reduce` rule in `main.css` collapses every
transition and animation duration to near-zero and disables smooth
scrolling, so no component needs its own reduced-motion branch for basic
hover/transition effects. Components with actual loops or slide-in motion
(hero, cover ring, filter drawer) still need an explicit reduced-motion
branch when they're built — the global rule only removes _duration_, not
JavaScript-driven animation logic.

## Typography

Three font families, self-hosted via `@nuxt/fonts` (Google provider,
`latin` + `cyrillic` + `cyrillic-ext` subsets, `font-display: swap`):

- **Tektur** (`--font-display`, weights 400–700) — display face. Used only
  for hero headlines, section titles and the logo. Class `.font-display-heading`
  applies the family and tightens tracking (`-0.02em`). Headings are written in
  sentence case ("Ігри, які варто знайти"); the logo reads "GG Stay". No
  `text-transform` — the text in the DOM is the text on screen.
- **Inter** (`--font-sans`, weights 400/500/600) — the interface face, applied
  to `body` by default. Every other piece of text uses it.
- **JetBrains Mono** (`--font-mono`, weights 400/500) — numerals only: years,
  scores, counts, page numbers. Class `.font-numeric` applies the family and
  `font-variant-numeric: tabular-nums` so digits line up like a results board.

**Deviation from the design doc:** Tektur is a variable font with a `wdth`
(width) axis, and the design doc asks for narrower widths (75–85) on long
Ukrainian headlines instead of shrinking the size. Google Fonts' CSS API
(what `@nuxt/fonts`' `google` provider requests) only ever exposes the
weight axis in the served `@font-face` rules — it does not expose `wdth`,
even though the source variable font file contains it. There is no
supported way to get a `font-stretch`/`wdth`-controllable face through this
provider. We ship Tektur at its default (100%) width for now; when the hero
headline is built (PR 6), long Ukrainian titles will be handled with
responsive `font-size` instead. If a narrower width turns out to matter for
layout, the fallback is switching to the `fontsource` (self-hosted npm
package) provider, which does serve the full variable font file.

## Colour usage rules

- **Accent (`--color-accent`) is reserved** for the primary call to action,
  active filter state, and the focus ring. It never appears as a decorative
  colour, a link colour, or a status colour.
- **Sale (`--color-sale`) is reserved** for price-reduction status only: the
  discount chip on `PriceTag` (catalog cards, the game page scoreboard). It is
  a deliberately separate token from accent — a discount badge is a status
  colour (a fact about the price), not a call to action, an active filter, or
  a focus ring, so it must not borrow accent's meaning. Never used for
  actions, links, or any other decorative purpose.
- **Signal (`--color-signal`) is reserved** for live/ephemeral states: "now on
  screen" captions, "coming soon" labels, and the filter-drawer reset action.
  It is not a general-purpose highlight colour.
- **The one exception is Gege, the mascot** (`GegeMascot`). He is the only illustration allowed to
  use accent and signal outside calls to action and live states: his body is `accent`, his eyes are
  `signal`, and his details are `ink` and `fg`. The exception covers his drawing and nothing around
  it — see "Gege, the mascot" below.
- **`fg-3` contrast note:** `fg-3` (`#6B7080`) on `ink` measures roughly
  3.9:1, below the 4.5:1 WCAG AA threshold for normal text. It is safe to use
  for large text (≥ 24px, or ≥ 18.66px bold) or for genuinely decorative
  captions where the information is redundant with something already
  announced at AA contrast — and **only** on `ink` or `surface-1`. On
  `surface-2` it drops further, to about 3.4:1, so `fg-3` is **not allowed**
  on `surface-2` at any size used in this app. For anything a user needs to
  read to understand the page (metadata labels, secondary copy, placeholder
  text), use `fg-2` instead, which is what every component built in this PR
  does — no component in this PR emits `text-fg-3` anywhere.
- **Numerals rule:** `.font-numeric` wraps bare numbers only — years, scores,
  counts, page numbers. A full written date ("18 травня 2015") or any string
  that interpolates a number into words stays in the interface face
  (`font-sans`); only the number inside it gets `.font-numeric`, via
  `<i18n-t>` with a slot around just that number.
- `.font-numeric` also sets `word-spacing: -0.3em` so the uk-UA thousands
  separator (a no-break space) reads as a thin gap instead of a full
  monospace cell in JetBrains Mono.
- **Decimal rule:** mono for integers; decimals use the interface face with
  tabular figures. A decimal's separator (comma in uk-UA, point in en-US)
  renders as a full monospace cell in JetBrains Mono, which reads like an
  extra digit ("4 , 6"). Decimal values (e.g. a 4,6 user rating) use
  `.font-tabular` instead of `.font-numeric` — `font-variant-numeric:
tabular-nums` in the interface face, without switching to the mono family.

### Image sizes

`@nuxt/image`'s `sizes` prop is **not** a CSS `sizes` attribute. It takes
`breakpoint:value` pairs keyed on `image.screens` in `nuxt.config.ts`
(`sm` 420, `md` 640, `lg` 1280, plus the module's own `xl` 1280 / `2xl` 1536),
and it fails silently on anything else: a CSS media-query string decomposes
into a single fixed width, and a bare `33vw` with no breakpoint key produces
one `0w` candidate, which is an invalid descriptor that voids the whole
`srcset`. Both bugs shipped once. Only a bare pixel value (`200px`) is safe
without a key.

**The bands do not line up with Tailwind's.** `md:` here covers viewports from
640 to 1279px, where the catalog grid is 2, 3 _and_ 4 columns, so a `vw` value
cannot describe that band honestly — 50vw is right at its bottom and twice the
slot at its top. Where a band spans several column counts, declare the widest
slot the band actually renders as a fixed pixel value instead.

Every `sizes` string lives as a named constant in `app/utils/rawgImage.ts`,
written against the layout's real slot width across each breakpoint band
(`sm:` covers viewports up to 639px, `md:` up to 1279px, `lg:` above), and
every one is covered by a test in `tests/app/imageSizes.test.ts` that asserts
the **emitted** `sizes` and `srcset` — and, for the grid, which candidate a
given viewport and device pixel ratio actually resolve to. The input string
alone says nothing about what the browser receives, and the candidate list
alone says nothing about which one it picks.

### Card meta row

- **Platforms are short text labels, not glyphs.** `PlatformIcons` renders a
  `<ul>` of plain text (`PC`, `PlayStation`, `Xbox`, `Nintendo`, `Mobile` /
  `Мобільні`), separated by a middle dot, 12–13px `fg-2`, in enum order with
  `OTHER` always hidden. Text needs no trademark artwork and is accessible by
  default. A `max` prop (default 5) caps how many labels show before a mono
  `+N`. The catalog card passes `responsive` instead of a `max`: that mode
  renders three container-query variants capped at 1, 2 and 3 labels, marks
  all three `aria-hidden` and exposes one `sr-only` span with the full list,
  so a narrow column never wraps and assistive technology still hears every
  platform. `+N` carries the hidden platform names as its `title`/accessible
  name.
- **The Metacritic score is labelled.** `MetacriticBadge` takes an optional
  `caption` prop; when set (the catalog card — the game page scoreboard
  already has a visible `dt` caption, so it passes the badge unchanged), a
  visible "Metacritic" caption (12px, `fg-2`) precedes the coloured score
  chip, so the row reads "Metacritic 82" instead of a bare number. Below a
  ~360px card width "Metacritic" no longer fits on the line, so the caption
  falls back to "MC" with a `title="Metacritic"` tooltip at that width only.
  The chip itself (band colour, accessible name) is unchanged.

### Contrast ratios computed for this PR

| Foreground            | Background            | Ratio   | Passes AA (normal text, 4.5:1)?   |
| --------------------- | --------------------- | ------- | --------------------------------- |
| `fg` `#ECEDEF`        | `ink` `#0B0C10`       | 16.69:1 | Yes                               |
| `fg-2` `#A3A7B3`      | `ink` `#0B0C10`       | 8.13:1  | Yes                               |
| `fg-3` `#6B7080`      | `ink` `#0B0C10`       | 3.96:1  | No (large text / decorative only) |
| `fg` `#ECEDEF`        | `surface-1` `#13151B` | 15.58:1 | Yes                               |
| `fg-2` `#A3A7B3`      | `surface-1` `#13151B` | 7.59:1  | Yes                               |
| `fg-3` `#6B7080`      | `surface-2` `#1A1D25` | 3.41:1  | **No — not allowed at any size**  |
| `on-accent` `#1A1200` | `accent` `#F5A524`    | 9.10:1  | Yes                               |
| `on-sale` `#0B0C10`   | `sale` `#B6F36A`      | 14.91:1 | Yes                               |

The sale chip's background must also read as a distinct shape against the card surfaces it sits
on (WCAG 1.4.11 non-text contrast, ≥ 3:1 for UI component boundaries), not just its own text:
`sale` `#B6F36A` against `surface-1` `#13151B` is 13.92:1, and against `surface-2` `#1A1D25` is
12.85:1 — both far past the 3:1 floor, no lightness adjustment needed.

## Accessibility

- Every focusable element gets a visible focus ring: `:focus-visible` is
  styled globally as a 2px solid accent-coloured outline with a 2px offset.
- `html { color-scheme: dark }` is set so native form controls (scrollbars,
  checkboxes, date pickers) render in dark mode by default; checkboxes and
  radios additionally set `accent-color` to the accent token.
- `prefers-reduced-motion: reduce` disables all CSS transitions and
  animations site-wide. Components with genuine motion loops (hero video,
  cover ring, count ticker, drawer slide-in) implement their own explicit
  branch when they land, per the design doc.
- WCAG AA contrast is checked for every text/background combination used —
  see the table above.

## Component inventory

Status values: **exists** (unchanged since before the redesign),
**restyled in PR 1** (tokens/classes only, no behaviour change),
**done** (built and finished as designed).

| Component                       | Status                                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppHeader`                     | Added in PR 1; skip link and a labelled primary nav landmark added in PR 9; "Запитати" link beside the catalog in week 3, renamed "AI-підбір" with Gege's face before it                                      |
| `GegeMascot`                    | Done — the AI-picks mascot, an inline pixel-art SVG with four moods; see "Gege, the mascot" below                                                                                                             |
| `GegeGreeter`                   | Done — the landing page's greeting: Gege rises from the corner with the deal of the day; see "Gege, the mascot" below                                                                                         |
| `GegeSpeech`                    | Done — Gege beside a speech bubble in the page's flow (the greeter's bubble look); used by the ask page                                                                                                       |
| `AppFooter`                     | Added in PR 9 — extracted from `layouts/default`: logo/tagline, nav links, GitHub, `LocaleSwitcher`, RAWG/Steam attribution                                                                                   |
| `HeaderSearch`                  | Done — PR 5; mobile-expanded search fixed to a full-bleed overlay (no logo overlap) in PR 9                                                                                                                   |
| `HeroFeatured`                  | Done — PR 6                                                                                                                                                                                                   |
| `HeroVideo`                     | Done — PR 6                                                                                                                                                                                                   |
| `CoverRing`                     | Done — PR 7; `onFocusOut` hardened against a null `relatedTarget` in PR 9                                                                                                                                     |
| `CoverMarquee`                  | Done — PR 7                                                                                                                                                                                                   |
| `WhyCards`                      | Done — PR 7                                                                                                                                                                                                   |
| `GameRow`                       | Done — PR 7; renders the five landing shelves and the game page's "Схожі ігри" row since week 2B                                                                                                              |
| `MetacriticBadge`               | Done — PR 3                                                                                                                                                                                                   |
| `PlatformIcons`                 | Done — PR 3                                                                                                                                                                                                   |
| `ActiveFilterChips`             | Done — PR 4; PR 7 added the price/discount/localisation chips and the struck-through "not applied" state                                                                                                      |
| `ReadonlyFilterChips`           | Done — week 3 — the catalog's chip words for a filter a page shows but does not own: a visible caption, no remove or reset                                                                                    |
| `FilterDrawer`                  | Done — PR 4                                                                                                                                                                                                   |
| `FilterSection`                 | Done — PR 4                                                                                                                                                                                                   |
| `SegmentedControl`              | Done — PR 4                                                                                                                                                                                                   |
| `YearRangeSlider`               | Done — PR 4                                                                                                                                                                                                   |
| `ViewToggle`                    | Done — PR 4                                                                                                                                                                                                   |
| `ResultCount`                   | Done — PR 4                                                                                                                                                                                                   |
| `ScreenshotGallery`             | Done — PR 8                                                                                                                                                                                                   |
| `ScreenshotGalleryLightbox`     | Done — PR 8; loaded as its own chunk when a thumbnail is opened                                                                                                                                               |
| `GameHero`                      | Done — PR 8 — full-bleed cover with the scoreboard slotted over it                                                                                                                                            |
| `GameScoreboard`                | Done — PR 8 — released / Metacritic / player rating / platforms as a `<dl>`; week 2B added the "Походження: Зроблено в Україні" item                                                                          |
| `filters/CheckboxList`          | Done — PR 4                                                                                                                                                                                                   |
| `filters/DeveloperAutocomplete` | Done — PR 4 — debounced client-only lookup against the BFF                                                                                                                                                    |
| `pages/index.vue`               | Full landing page — PR 6/7; five shelves replace the two rows in week 2B                                                                                                                                      |
| `FilterPanel`                   | Done — `SegmentedControl`/`YearRangeSlider` swap landed in PR 4; "Ціна", "Знижка" and "Українська локалізація" sections added in PR 7; "Походження" section added in week 2B                                  |
| `filters/PriceFilter`           | Done — PR 7 — free/300/600/1 000 chips plus a labelled, debounced own-amount field                                                                                                                            |
| `filters/DiscountFilter`        | Done — PR 7 — 25/50/75 %, single choice, pressed again to clear                                                                                                                                               |
| `CatalogIndexNote`              | Done — PR 7 — the "top 3 000" note and the price age, both under the result count                                                                                                                             |
| `CatalogStaleBanner`            | Done — PR 7 — above the grid when the index's prices are too old to show                                                                                                                                      |
| `filters/RadioList`             | Replaced by `SegmentedControl` in PR 4                                                                                                                                                                        |
| `filters/YearRange`             | Replaced by `YearRangeSlider` in PR 4                                                                                                                                                                         |
| `GameCard`                      | Full restyle (hover, score band, platform icons) in PR 3; title heading level made configurable (`h2` on the catalog grid, `h3` under `GameRow`'s own `h2`) in PR 9; "Зроблено в Україні" label in week 2B    |
| `GameGrid`                      | Restyled in PR 1; passes `heading-level="2"` to `GameCard` since PR 9                                                                                                                                         |
| `SortSelect`                    | Restyled in PR 1 (dark pass); PR 7 added the three price sorts, hid them while the index is stale and named a sort the answer dropped                                                                         |
| `Pagination`                    | Restyled in PR 1 (dark pass)                                                                                                                                                                                  |
| `states/LoadingState`           | Restyled in PR 1 (dark pass)                                                                                                                                                                                  |
| `states/EmptyState`             | Restyled in PR 1 (dark pass); "Опишіть словами" link to the ask page in week 3                                                                                                                                |
| `states/ErrorState`             | Restyled in PR 1 (dark pass)                                                                                                                                                                                  |
| `StoreLinks`                    | Restyled in PR 1 (dark pass)                                                                                                                                                                                  |
| `LocaleSwitcher`                | Restyled in PR 1 (dark pass)                                                                                                                                                                                  |
| `layouts/default`               | Header extracted to `AppHeader` in PR 1; footer extracted to `AppFooter`, skip link and `#main-content` landing target added in PR 9. Owns the single `<main>` of every route — pages render sections into it |
| `error.vue`                     | Restyled in PR 1 (dark pass)                                                                                                                                                                                  |
| `pages/games/[slug].vue`        | Full restyle (scoreboard row, gallery) in PR 8; "Схожі ігри" row below the store links in week 2B; the "still loading" line over the cover of a page answered in part — see "A game page answered in part"    |
| `pages/ask.vue`                 | Done — week 3 — natural-language search; rebuilt around Gege, with the games as rows; see "Ask page" below                                                                                                    |
| `ask/AskResultRow`              | Done — one game of an answer as a row, the reason as its primary line; see "Ask page" below                                                                                                                   |
| `ask/AskWaiting`                | Done — Gege thinking, a line that changes with the clock, and the outline of the rows; see "Ask page" below                                                                                                   |

### Footer (PR 9)

`AppFooter` replaces the plain attribution strip that used to live inline in
`layouts/default.vue`. Three columns on `sm:` and up (stacked below that):
the "GG Stay" logo (display face) with the same one-line tagline used for
`<meta name="description">` (`home.description`), a labelled nav
(`footer.nav`) with links to the catalog, new releases
(`/games?sort=RELEASED_DESC`) and the project's GitHub repository (an
inline, hand-drawn `currentColor` SVG mark, external with
`rel="noopener noreferrer"`), and `LocaleSwitcher`. A bottom row in
`fg-2` keeps the existing RAWG/Steam attribution sentence and the
ownership sentence, both already present in the locale files.

### Accessibility additions (PR 9)

- A skip link ("Перейти до вмісту" / "Skip to content") is the first
  focusable element on every page, targeting `#main-content` (the
  layout's content wrapper, which every page's own `<main>` sits inside).
- `AppHeader`'s catalog link is wrapped in a `<nav aria-label="nav.primary">`;
  `AppFooter`'s link group is a `<nav aria-label="footer.nav">` — both
  landmarks are distinguishable from each other and from the existing
  `LocaleSwitcher`/`Pagination` navs, which were already labelled.
- **Ring covers decision (design doc vs. shipped behaviour):** the design
  doc asked for ring covers to be "hidden from assistive technology except
  the focused one." `CoverRing` ships with every cover as a real,
  always-focusable `NuxtLink` instead. Kept as-is: the covers' DOM order
  matches their visual rest order, each has a correct accessible name (the
  game's title, via `alt`), Arrow Left/Right step through them without
  requiring 24 individual Tab presses, and the `role="status"` live region
  only announces on a real focus change (not once per animation frame), so
  it is not chatty. Rotation itself is a purely visual/decorative effect a
  screen reader user never needs to perceive — exposing every cover as a
  reachable link gives that user strictly more access to the row's content
  than hiding 23 of 24 items would, and implementing a stricter
  roving-tabindex/`aria-hidden` scheme risked behaviour regressions in a
  pass that is not supposed to change behaviour.

### Price, discount and localisation filters (PR 7)

The three index-backed sections sit at the top of the drawer, above "Платформа",
because they are the ones a visitor reaches for first; each is collapsed until it
holds a value, like every other section, and each is counted in the
"Фільтри (N)" badge and carries its own chip.

- **"Ціна"** — `filters/PriceFilter`: "Безкоштовно" and three ready-made
  ceilings as `aria-pressed` toggle chips (the same chip pattern as
  `filters/CheckboxList`), plus a hand-typed amount. `free` and `priceMaxUah`
  are separate URL keys and separate chips, but the section never sets both:
  choosing one clears the other. The own-amount field is a real `<label>` +
  `<input type="number" inputmode="numeric" min="1">`, never a placeholder
  standing in for a label, and it waits 400 ms after the last keystroke so
  typing "1000" costs one navigation instead of four. Amounts outside 1–100 000
  are not written to the URL at all.
- **"Знижка"** — `filters/DiscountFilter`: 25/50/75 % as a single choice,
  pressed again to clear. A percent from a shared link that is not one of the
  three (`onSaleMinPercent=33`) is shown as a fourth pressed chip rather than
  quietly left out — a filter that is counted has to be visible and removable.
- **"Українська локалізація"** — `SegmentedControl` with "Не важливо" as the
  cleared state and "Будь-яка / Текст / Озвучка" as the three levels, so the
  radio-group keyboard behaviour is the one already shipped.

Hryvnia in chips and section labels goes through `formatUah`, which writes the
₴ and the group separator itself; the bare number inside "до 300 ₴" and
"від 50 %" is wrapped in `.font-numeric` through an `<i18n-t>` slot, so the
surrounding words stay in the interface face.

**Notes and failure states.** When the index answered the page
(`indexedOnly`), `CatalogIndexNote` sits under the result count in `fg-2`: what
the search covered, and how old the prices are. The hour count is computed from
`indexUpdatedAt` and a `now` the page reads **once** (`useState('catalog-now')`,
so it comes from the server render and is carried in the payload) — no render
path reads a clock. When `indexStale`, `CatalogStaleBanner` goes above the grid,
the "Ціна" and "Знижка" sections and the three price sorts disappear, and
localisation stays. A filter the answer names in `ignoredFilters` keeps its chip
and its remove button, struck through, with the reason spelled out beside it as
visible text — not a `title`, because nothing here may depend on hover. An
ignored sort is named in the same words next to the select, which falls back to
showing the order the page is actually in.

The "Фільтри (N)" badge counts only the filters the answer **applied**. A filter
the server declined keeps its chip and its remove button — it is in the URL, so
it has to be — but it is not shaping the list, and a badge that counted it would
disagree with the results two lines below it. The chip row itself is shown
whenever the URL carries any filter at all, applied or not, so a page whose only
filter was declined still shows that filter and still lets a visitor take it
off.

### Shelves, made in Ukraine and similar games (week 2B)

- **Landing shelves.** Five `GameRow`s replace "Нові релізи" and "Найкращі за оцінкою гравців":
  "Зроблено в Україні", "Українською", "Зі знижкою", "Найкращі цього року", "Очікувані", in that
  order. Each has its visible title and an "Усі ігри" link; the title key and the catalog URL
  behind the link come from `shared/shelves.ts`, the same definition the resolver fills the shelf
  from, so a shelf shows the first games of the page it links to. The exception is "Найкращі
  цього року": the shelf ranks the year's forty most added games with at least twenty votes by
  rating, because RAWG's plain rating order is led by games almost nobody rated. Its link opens
  that pool — the year by popularity, where every shelf game is among the first forty — and is
  labelled "Усі ігри цього року" / "All of this year's games" instead of "Усі ігри", so it does
  not promise more of the same ranking. The link's year comes from the answer (`Landing.year`),
  not from a clock. A shelf the answer left out
  (fewer than four games, or an index that could not serve it) is simply not rendered.
- **"Зроблено в Україні" on a card** is a compact text label over the top-left corner of the
  cover: 12px `fg` on `ink` at 85 % with a `line` border, `rounded-chip`. It sits over the cover
  rather than in the text column so a card with it is exactly as tall as one without, and above
  the hover preview. It is plain words, never a flag or an icon, and uses no accent, signal or
  sale colour — it is a fact about the studio, not a call to action, a live state or a price.
- **On the game page** the scoreboard gains a "Походження" item whose value is "Зроблено в
  Україні", shown only for such games, with the same visible `dt` caption every item has.
- **"Схожі ігри"** is a `GameRow` without an "Усі ігри" link, full width below the gallery, the
  store links and the facts panel. It is absent when the answer has none.
- **Filter.** The drawer's "Походження" section (after "Українська локалізація", collapsed until
  it holds a value) holds one `aria-pressed` toggle, "Зроблено в Україні", with a one-line
  explanation under it in `fg-2`. It writes `madeInUkraine=1`, has its own chip, counts in the
  badge, and stays while the prices are stale, because it reads no price. The index note now reads
  "3 000 найпопулярніших ігор і всіх ігор українських студій".

### A game page answered in part

The server answers a game page inside a time budget, with what it has by then
(`docs/specs/2026-10-06-game-page-budget-design.md`). When not everything about the game had
arrived, the page is `partial`: it may lack its description, RAWG's screenshots, the stores other
than Steam and the genres, developer and publisher of the facts panel — or, for a Steam game the
index does not hold, only its price. Every section is simply absent until it has data — no
skeleton, no placeholder — exactly as it is for a game that has none.

- **The line.** One sentence says so — "Some of this page is still loading…" on the English page
  (it names no section, because what is missing may be the description and the screenshots, the
  store links, or only a Steam price), `game.stillLoading` in both locale files. It lies over the top-left corner of
  the cover, level with the title's left edge: 12px `fg-2` on `ink` at 85 % with a `line` border,
  `rounded-card` — a chip on one line, and still a sound shape on the two lines the English takes
  at 320 px. It is over the cover rather than in the flow for the reason the made-in-Ukraine label
  is over a card's: the page with it is laid out exactly as the page without it, so nothing moves
  when it appears and nothing when it goes. It uses no accent, signal or sale colour and no
  motion: it is not an action, a live state or a price, and a spinner would promise more than a
  page that may stay as it is. `fg-2` on that backdrop is 5.45:1 over a pure white cover, the
  lightest it can be, and 8.13:1 over `ink`.
- **What happens next.** In the browser, and only there, the page asks again by itself: three
  seconds after the answer it has, and six seconds after the next one if that is partial too
  (`useRetryWhilePartial`). A whole answer takes the place of the partial one in one step — the
  line goes, the sections that now have data appear where they belong, and the cover, the title
  and the scoreboard stay where they were; what arrives may push what is below it down. The one
  thing that arrives inside the scoreboard is the Steam price of a game the index does not hold.
  It takes its own cell there, and the scoreboard grows by a line or a row where the cell needs
  one: on a phone, where the hero is as tall as its content, that pushes down what is below; from
  640 px up, where the hero is held at its minimum height with its content on its bottom edge, it
  lifts the title instead (by 13 to 67 px on the Witcher's page, measured with its price held
  back). A second partial answer is not shown, and neither is a failure: the page a visitor is
  reading only ever changes for the whole one.
- **When the rest does not come.** After two attempts nothing more is asked, and the line stops
  saying that something is loading: "Some of this page didn't load. Try reloading it later."
  (`game.notLoaded`), in the same place and the same chip — one line from about
  500 px up, two at 375 and at 320 px in both languages, still clear of the title. It stays until
  the visitor reloads or leaves; the page under it is as it was.
- **Not in the server's markup.** The line follows what the page is doing, and a page does
  nothing until it is mounted in a browser. So the HTML the server sends for a partial page has
  the place for the line and no sentence in it: a crawler, or a browser that runs no scripts,
  keeps the partial page but is not told in its text that anything is still loading.
- **Announcement.** The line's place is a `role="status"` region that every game page has from
  its first render, empty and with no box of its own. The sentence is put into it once the page
  is mounted — a region that is there first and then gets its words is what a screen reader
  announces, as on the ask page. The attempts in between neither rebuild nor reword the line, so
  it is announced once; the final sentence takes the first one's place in the same element and is
  announced once too. What arrives is not announced.

### Share card (week 2C)

`public/og.png` (1200×630) is what a shared landing link previews as. It is drawn, not hand-made:
`scripts/og-image.ts` builds an SVG from the `@theme` tokens in `main.css` and renders it with the
site's own Tektur and Inter from the production build. On `ink`, a `surface-1` panel with a `line`
border holds the favicon's mark (the only accent on the card, as in the favicon itself), "GG Stay"
in Tektur and two lines in Inter `fg-2` — "Каталог відеоігор для українського гравця" and "Ціни в
гривнях · українська локалізація". `fg-2` on `surface-1` is 7.59:1. Game pages share their own
cover instead (the 1280 CDN variant), and the catalog shares its first card's cover.

### Ask page (week 3)

`/ask` (`/en/ask`) takes a question in words and answers with games from the catalog. The question
lives in the URL as `q`: the form only navigates, the server renders the answer, and a result is a
link that can be shared. With `q` the page is `noindex, follow` and its canonical is the plain
`/ask`; without it the page is indexable.

- **Gege.** The page is his (see "Gege, the mascot"): `GegeSpeech` puts him beside a speech bubble
  in the page's flow, and everything the page says about an answer is said in that bubble. The
  column is `max-w-3xl`, centred. Without a question he opens the page, 100 px wide and `idle`,
  beside a bubble whose title is the page's one `h1` — "Опиши гру, як сказав би другові" — over a
  line in `fg-2` on what to write; on a phone he stands on top of the bubble. With a question the
  `h1` stays as a plain line above the form and he moves down to the answer, so there is one Gege
  on screen at a time and the form and the answer share the first screen.
- **Form.** It never leaves the page: with an answer on screen the question is still in the field
  above it and can be edited and sent again. A visible label ("Яку гру шукаєш?") over one
  `surface-1` box that holds the textarea (200 characters at most, growing with its text), the
  counter ("40 із 200 символів", numbers in `.font-numeric` through an `<i18n-t>` slot, named in the
  field's `aria-describedby`) and the "Підібрати" button. The box wears the focus ring for the field
  inside it. Enter sends, Shift+Enter breaks the line. An empty question is answered with a
  sentence under the box and `aria-invalid`, never a disabled button. The submit button is the
  form's one accent element (a retry button in a failure state is the other accent on screen). The
  form is a `search` landmark named by its label. Three example questions — his suggestions, with
  his still 20 px face before the caption — are `surface-1` chip buttons, 44 px tall, shown while
  there is no question yet; each sends at once. A one-line note in `fg-2` says who reads the
  question and that it is not stored with an IP.
- **Answer.** Under an `h2` "Результати", Gege (60 px, 40 px on a phone) and his bubble: the
  interpretation in his voice ("Зрозумів так:" in `fg-2`, the sentence in `fg`); the understood
  filter as `ReadonlyFilterChips` under a visible "Зрозумілий фільтр:" caption ("Звичайний пошук:"
  in fallback, where nothing was understood); "Відкрити в каталозі" as a plain underlined link —
  not a chip, so it does not read as one more filter value — whose query is re-validated through
  the catalog's own URL layer, shown only when that query is not empty (a "like X" answer or one
  with nothing understood has no filter to open, and the whole catalog would show none of its
  games); the count; and the catalog's index note. He is `happy` for a moment when an answer he
  picked is rendered, then `idle`. The interpretation and the reasons are model-written: rendered
  by text interpolation only, held to 200 and 120 characters, and allowed to break inside a long
  word. The search chip — in fallback, the whole question — wraps, clamped to two lines with the
  full text still in the DOM and its `title` (`rounded-card` rather than `rounded-chip` once it can
  take two lines); value chips stay on one line. Nothing on the page scrolls sideways at 375 px.
- **Rows.** The games are rows (`ask/AskResultRow`), not catalog cards: a 160 px cover
  (`ASK_ROW_IMAGE_SIZES`), the name as an `h3` and the row's one link (stretched over the row,
  which draws the focus ring), **the reason as the primary line under the name** — `fg` at the body
  size, no caption before it — then year, platforms, the Metacritic chip and "Зроблено в Україні",
  with the price, its discount and the localisation badge on the right. On a phone the cover
  shrinks to 96 px beside the name and the reason, the facts and the price each run the full width
  under them. A game the endpoint sent without a reason (its rerank failed) has no reason line at
  all, not an empty one. Every row of an answer is in the document — nothing is paged, folded or
  loaded later — and the count line is the length of the same list, so "Підібрав 8 ігор" is eight
  rows on about two screens. (As cards, two to a row and 400 px tall under a taller form, the same
  eight were four screens of covers, and the first screen showed four of them.)
- **Filters the catalog could not apply.** The answer's `ignoredFilters` strike the matching chips
  through with the catalog's reason beside them in words (`ignoredFilterReason`, shared with
  `ActiveFilterChips`), a declined sort is named as the catalog names it ("«Спочатку дешевші» не
  застосовано"), and when stale prices are the reason the catalog's `CatalogStaleBanner` sits above
  the answer. Whether the prices were stale comes from the answer's own `indexStale` (the catalog
  page its cards came from), because a declined price filter alone fits a silent index too.
- **States.** Every one is Gege beside a bubble. Waiting (`ask/AskWaiting`): he is `thinking` and
  the bubble's line changes with the clock — "Читаю запит…", "Шукаю ігри…" after 2 s, "Пояснюю
  вибір…" after 4 s — over the outline of three rows, the section `aria-busy`. The lines are timed,
  not reported by the endpoint. Fallback: he says the calm sentence, no colour and no alert role —
  "ШІ-розбір зараз недоступний — показую звичайний пошук" — above the plain search's rows, and
  stays `idle`. Empty: the bubble suggests rephrasing, and opening the filter in the catalog only
  when there is one. Rate limited: "Спробуй ще раз за N секунд" from `Retry-After` (read on the
  server and carried in the payload, never computed from a clock), or "за хвилину" without one.
  Failed: a sentence and a retry button. Too long (the endpoint's 400): "Запит задовгий…", with no
  retry. All three failures are `role="alert"` inside his bubble, and he is `idle` beside them.
- **Announcements and focus.** A `role="status"` region always says the current state ("Читаю
  запит…" once for the whole wait — the lines that follow on screen are not announced — then
  "Підібрав 3 гри", the fallback note and count, or "Нічого не підібрав"); it is derived from
  the answer, so the server and the hydrated client agree. Focus moves to the results heading when
  an answer the visitor just asked for lands; a page opened from a link moves no focus.
- **Back and Forward.** Answers are remembered per tab, in memory and bounded, by locale and
  question; history navigation renders them without a request or a skeleton (every ask costs one of
  the visitor's ten a minute, and a fallback is never cached by the endpoint). A question sent from
  the form, and "Спробувати ще раз", always ask; failures are not remembered.
- **Ways in.** "AI-підбір" (until Gege arrived, "Запитати") sits beside "Каталог" in the header's
  primary navigation with Gege's face before it, and the
  catalog's empty state ends with "Не знаєте, які фільтри обрати? Опишіть словами".

### Gege, the mascot

**Ґеґе** (English: **Gege**, from "GG") is a living pixel-art gamepad and the face of the AI game
picking. `GegeMascot` draws him as an inline SVG — no image file, no dependency — on a 20 × 13
grid with `shape-rendering="crispEdges"`: a rounded top, two grips as legs, two eyes, a d-pad on
the left, four face buttons on the right and a small mouth. He is decorative (`aria-hidden`, not
focusable); the text beside him always carries the meaning.

- **Colour.** Tokens only, and the documented exception to the accent and signal rules above: the
  body is `accent`, the eyes `signal`, the pupils, mouth, d-pad and buttons `ink`, the glint in each
  eye `fg`. The one highlight and the one darker amber are `color-mix()` of `accent` with `fg` and
  with `ink`, so the drawing holds no colour value of its own. Nothing else may borrow this
  exception: a bubble, a button or a caption near him follows the ordinary rules.
- **Size.** `size` is his width in CSS pixels; the height follows the grid (13/20). The grid is 20
  wide because the header shows him 20 px wide, one cell to one pixel. Multiples of 20 are
  pixel-perfect; other widths stay crisp with cells that differ by a pixel.
- **Moods.** `idle` — open eyes and a smile; he floats 3 px in whole-pixel steps and blinks every
  few seconds. `peek` — the idle face tilted −8°, swaying to −3°. `thinking` — half-lidded eyes, a
  flat mouth, and the four face buttons lighting up in `signal` one after another, clockwise.
  `happy` — eyes as arcs, an open mouth and one short hop.
- **Motion.** CSS keyframes only, held steps where it suits pixel art, and only with the
  `animated` prop (default on). Under `prefers-reduced-motion: reduce` the component removes its
  animations outright and each mood keeps its static pose: the tilt for `peek`, the first button
  lit for `thinking`. `:animated="false"` gives the same still pose on request.
- **In the header** he is a still 20 px face before the "AI-підбір" / "AI picks" link to `/ask`.
  The link's accessible name is its text. A narrow bar has no room for him, and the logo never
  wraps to make some: the face is left out below 360 px, and below 400 px on the English site,
  whose locale switcher ("Українська") is the widest. The label may wrap below 360 px (375 px in
  English).
- **On `/ask`** `GegeSpeech` stands him to the left of a bubble with the same look as the
  greeter's — `surface-2`, a 1 px `accent` border, `rounded-card`, a tail pointing at him. `lead`
  is the page's opening line (100 px, level with the middle of the bubble; above it on a phone);
  `reply` is a line in the conversation (60 px at the bubble's top corner, resized to 40 px on a
  phone by a rule, so the server render needs no viewport). He is `idle` at the start and beside
  an empty answer or a failure, `thinking` during the wait, and `happy` for a moment over an answer
  he picked.
- **On the landing page** `GegeGreeter` brings him up from the bottom-right corner (`peek`, 120 px
  wide, 80 px on a phone) two seconds after the page is interactive and the tab is on screen, with
  a speech bubble: `surface-2`, a 1 px `accent` border, `rounded-card`, body copy in the interface
  face and only his name in Tektur. The bubble sits beside him on a wide screen. On a phone the
  hero's actions are where the bubble would be, so he comes up with one line beside him instead —
  a 44 px button in the bubble's look, on the strip under the hero's actions — and a tap on it or
  on him opens the bubble above him; left alone for eight seconds he dives by himself. Above him,
  the bubble and he take the bottom third of the small viewport; past that the copy scrolls inside
  the bubble, above the buttons, in a box that takes keyboard focus and fades its last visible
  line while there is more below. A third of a short screen cannot hold the copy, so the copy
  keeps up to 8 rem wherever there is room for it under the header. The discount is the ordinary
  `sale` chip, the call to action the ordinary `accent` button: the colour exception stays with
  his drawing. Dismissed, he dives head first and leaves one grip in the corner, a 56 × 44 px
  button that opens the bubble again. He rises by himself once per browser session. The greeter is fixed, teleported to `<body>`, a labelled `<aside>` that never
  takes focus by itself, and is mounted in the browser only, after idle. The rise and the dive run
  250 ms ease-out; with reduced motion he is simply there.
