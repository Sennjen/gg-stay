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

Score-band chips (`MetacriticBadge`) land in PR 3 with the restyled card; this
PR only reserves the tokens.

### Radius

- `--radius-card` = 12px → `rounded-card`, used for cards, panels and dialogs.
- `--radius-chip` = 999px → `rounded-chip`, used for chips and buttons (same
  value as Tailwind's built-in `rounded-full`, named separately so intent is
  clear in templates).

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
  applies the family, forces lowercase and tightens tracking (`-0.02em`), matching
  the "ігри, які варто знайти" style headline in the design doc.
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
**planned** (arrives in a later PR per the design doc's work order).

| Component                | Status                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `AppHeader`              | Added in PR 1                                                                          |
| `HeaderSearch`           | Planned — PR 5                                                                         |
| `HeroFeatured`           | Planned — PR 6                                                                         |
| `HeroVideo`              | Planned — PR 6                                                                         |
| `CoverRing`              | Planned — PR 7                                                                         |
| `CoverMarquee`           | Planned — PR 7                                                                         |
| `WhyCards`               | Planned — PR 7                                                                         |
| `GameRow`                | Planned — PR 7                                                                         |
| `MetacriticBadge`        | Planned — PR 3                                                                         |
| `PlatformIcons`          | Planned — PR 3                                                                         |
| `ActiveFilterChips`      | Planned — PR 4                                                                         |
| `FilterDrawer`           | Planned — PR 4                                                                         |
| `FilterSection`          | Planned — PR 4                                                                         |
| `SegmentedControl`       | Planned — PR 4                                                                         |
| `YearRangeSlider`        | Planned — PR 4                                                                         |
| `ViewToggle`             | Planned — PR 4                                                                         |
| `ResultCount`            | Planned — PR 4                                                                         |
| `ScreenshotGallery`      | Planned — PR 8                                                                         |
| `pages/index.vue`        | Dark pass only in PR 1 — full landing rebuild is PR 6/7                                |
| `FilterPanel`            | Restyled in PR 1 (dark pass); `SegmentedControl`/`YearRangeSlider` swap in PR 4        |
| `filters/RadioList`      | Restyled in PR 1 (dark pass); replaced by `SegmentedControl` in PR 4                   |
| `filters/YearRange`      | Restyled in PR 1 (dark pass); replaced by `YearRangeSlider` in PR 4                    |
| `GameCard`               | Restyled in PR 1 (dark pass); full restyle (hover, score band, platform icons) in PR 3 |
| `GameGrid`               | Restyled in PR 1 (dark pass)                                                           |
| `SortSelect`             | Restyled in PR 1 (dark pass)                                                           |
| `Pagination`             | Restyled in PR 1 (dark pass)                                                           |
| `states/LoadingState`    | Restyled in PR 1 (dark pass)                                                           |
| `states/EmptyState`      | Restyled in PR 1 (dark pass)                                                           |
| `states/ErrorState`      | Restyled in PR 1 (dark pass)                                                           |
| `StoreLinks`             | Restyled in PR 1 (dark pass)                                                           |
| `LocaleSwitcher`         | Restyled in PR 1 (dark pass)                                                           |
| `layouts/default`        | Header extracted to `AppHeader`, footer restyled in PR 1                               |
| `error.vue`              | Restyled in PR 1 (dark pass)                                                           |
| `pages/games/[slug].vue` | Dark pass in PR 1; full restyle (scoreboard row, gallery) in PR 8                      |
