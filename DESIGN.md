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
the hero video and the cover ring (both arrive in later PRs). A global
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
| `AppHeader`                     | Added in PR 1; skip link and a labelled primary nav landmark added in PR 9                                                                                                                                    |
| `AppFooter`                     | Added in PR 9 — extracted from `layouts/default`: logo/tagline, nav links, GitHub, `LocaleSwitcher`, RAWG/Steam attribution                                                                                   |
| `HeaderSearch`                  | Done — PR 5; mobile-expanded search fixed to a full-bleed overlay (no logo overlap) in PR 9                                                                                                                   |
| `HeroFeatured`                  | Done — PR 6                                                                                                                                                                                                   |
| `HeroVideo`                     | Done — PR 6                                                                                                                                                                                                   |
| `CoverRing`                     | Done — PR 7; `onFocusOut` hardened against a null `relatedTarget` in PR 9                                                                                                                                     |
| `CoverMarquee`                  | Done — PR 7                                                                                                                                                                                                   |
| `WhyCards`                      | Done — PR 7                                                                                                                                                                                                   |
| `GameRow`                       | Done — PR 7                                                                                                                                                                                                   |
| `MetacriticBadge`               | Done — PR 3                                                                                                                                                                                                   |
| `PlatformIcons`                 | Done — PR 3                                                                                                                                                                                                   |
| `ActiveFilterChips`             | Done — PR 4; PR 7 added the price/discount/localisation chips and the struck-through "not applied" state                                                                                                      |
| `FilterDrawer`                  | Done — PR 4                                                                                                                                                                                                   |
| `FilterSection`                 | Done — PR 4                                                                                                                                                                                                   |
| `SegmentedControl`              | Done — PR 4                                                                                                                                                                                                   |
| `YearRangeSlider`               | Done — PR 4                                                                                                                                                                                                   |
| `ViewToggle`                    | Done — PR 4                                                                                                                                                                                                   |
| `ResultCount`                   | Done — PR 4                                                                                                                                                                                                   |
| `ScreenshotGallery`             | Done — PR 8                                                                                                                                                                                                   |
| `ScreenshotGalleryLightbox`     | Done — PR 8; loaded as its own chunk when a thumbnail is opened                                                                                                                                               |
| `GameHero`                      | Done — PR 8 — full-bleed cover with the scoreboard slotted over it                                                                                                                                            |
| `GameScoreboard`                | Done — PR 8 — released / Metacritic / player rating / platforms as a `<dl>`                                                                                                                                   |
| `filters/CheckboxList`          | Done — PR 4                                                                                                                                                                                                   |
| `filters/DeveloperAutocomplete` | Done — PR 4 — debounced client-only lookup against the BFF                                                                                                                                                    |
| `pages/index.vue`               | Full landing page — PR 6/7                                                                                                                                                                                    |
| `FilterPanel`                   | Done — `SegmentedControl`/`YearRangeSlider` swap landed in PR 4; "Ціна", "Знижка" and "Українська локалізація" sections added in PR 7                                                                         |
| `filters/PriceFilter`           | Done — PR 7 — free/300/600/1 000 chips plus a labelled, debounced own-amount field                                                                                                                            |
| `filters/DiscountFilter`        | Done — PR 7 — 25/50/75 %, single choice, pressed again to clear                                                                                                                                               |
| `CatalogIndexNote`              | Done — PR 7 — the "top 3 000" note and the price age, both under the result count                                                                                                                             |
| `CatalogStaleBanner`            | Done — PR 7 — above the grid when the index's prices are too old to show                                                                                                                                      |
| `filters/RadioList`             | Replaced by `SegmentedControl` in PR 4                                                                                                                                                                        |
| `filters/YearRange`             | Replaced by `YearRangeSlider` in PR 4                                                                                                                                                                         |
| `GameCard`                      | Full restyle (hover, score band, platform icons) in PR 3; title heading level made configurable (`h2` on the catalog grid, `h3` under `GameRow`'s own `h2`) in PR 9                                           |
| `GameGrid`                      | Restyled in PR 1; passes `heading-level="2"` to `GameCard` since PR 9                                                                                                                                         |
| `SortSelect`                    | Restyled in PR 1 (dark pass); PR 7 added the three price sorts, hid them while the index is stale and named a sort the answer dropped                                                                         |
| `Pagination`                    | Restyled in PR 1 (dark pass)                                                                                                                                                                                  |
| `states/LoadingState`           | Restyled in PR 1 (dark pass)                                                                                                                                                                                  |
| `states/EmptyState`             | Restyled in PR 1 (dark pass)                                                                                                                                                                                  |
| `states/ErrorState`             | Restyled in PR 1 (dark pass)                                                                                                                                                                                  |
| `StoreLinks`                    | Restyled in PR 1 (dark pass)                                                                                                                                                                                  |
| `LocaleSwitcher`                | Restyled in PR 1 (dark pass)                                                                                                                                                                                  |
| `layouts/default`               | Header extracted to `AppHeader` in PR 1; footer extracted to `AppFooter`, skip link and `#main-content` landing target added in PR 9. Owns the single `<main>` of every route — pages render sections into it |
| `error.vue`                     | Restyled in PR 1 (dark pass)                                                                                                                                                                                  |
| `pages/games/[slug].vue`        | Full restyle (scoreboard row, gallery) in PR 8                                                                                                                                                                |

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
