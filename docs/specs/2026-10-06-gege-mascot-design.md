# Gege — the AI-picks mascot

Date: 2026-10-06. Status: approved by the owner in conversation.

## Why

The natural-language search lives behind a header link that says only "Запитати" and a page that
looks like a plain form. Nothing tells a visitor it is the smart, AI-driven way to find a game, and
the page does not match the tone the rest of the site aims for with a young audience.

## What

A mascot, **Ґеґе** (English: **Gege**, from "GG"), a living pixel-art gamepad, becomes the face of
the feature:

1. The header link is renamed and carries his face.
2. On the landing page he peeks out of the bottom-right corner, greets the visitor, offers the deal
   of the day and invites them to let him pick more games.
3. On `/ask` he explains what to do, shows what he is doing while the answer is prepared, and
   presents the answer as his own reply.

No behaviour of `/api/ask` changes. No model call is added anywhere.

## 1. The character

- One Vue component, `GegeMascot.vue`, an inline SVG drawn on a pixel grid
  (`shape-rendering="crispEdges"`), no image files, no new dependency. Decorative by default
  (`aria-hidden="true"`); the text around him carries the meaning.
- Shape: a gamepad seen from the front — rounded top, two grips as legs; two eyes on the body; a
  d-pad on the left and four face buttons on the right; a small mouth. A reference sketch on a
  16 × 10 grid (improve the drawing — more pixels, shading with one darker amber and one highlight
  are welcome — but keep it readable at 20 px wide):
  - body `--color-accent` (#F5A524): rows y0 x3–12; y1 x1–14; y2–6 x0–15; y7 x0–5 and x10–15;
    y8 x0–4 and x11–15; y9 x1–3 and x12–14
  - eyes `--color-signal` (#2DD4BF): 2 × 2 at (5,2) and (9,2), pupils `--color-ink` 1 × 1 at (6,3)
    and (10,3)
  - mouth ink 2 × 1 at (7,5); d-pad ink cross centred (2,4); buttons ink 1 × 1 at (13,3), (13,5),
    (12,4), (14,4)
- Colours only from the design tokens in `DESIGN.md`. This is a deliberate, documented extension of
  the accent/signal rules: the mascot is the one illustration allowed to use accent and signal
  outside calls to action and live states. Record it in `DESIGN.md`.
- Prop `mood`: `idle` (blinks every few seconds, floats 2–3 px), `peek` (tilted about −8°, sways),
  `thinking` (eyes narrowed; the four face buttons light up in `--color-signal` one after another,
  as if he were pressing himself), `happy` (eyes as arcs, one short hop). Prop `size` in px.
- All motion is CSS (`@keyframes`, `steps()` where it suits pixel art). Under
  `prefers-reduced-motion: reduce` every loop stops and he is drawn in the static pose of the mood.

## 2. Header

- The link to `/ask` reads **«AI-підбір»** (uk) / **"AI picks"** (en) with a 20 px-wide mascot face
  before the text; it keeps the existing link styles and active state. Accessible name is the text.

## 3. Deal of the day

- New GraphQL field `dealOfTheDay: GameCard` (nullable) on `Query`, answered from the index only:
  among games with a fresh price, `discountPercent ≥ 50`, not free, Metacritic ≥ 75, take the
  biggest discounts (top 20 by `DISCOUNT_DESC`) and pick one deterministically from the current UTC
  date (`context.today`), so every visitor sees the same game all day and a different one tomorrow.
  Reuse the index query path and its page cache; no new Redis keys, no extra commands beyond one
  cached page read. `null` when the index is unavailable, its prices are stale, or nothing
  qualifies. It must respect the GraphQL query limits and never fail the landing page.

## 4. Landing greeter

- `GegeGreeter.vue`, mounted on the landing page only, client-side and lazily (it must not be in
  the server-rendered HTML's critical path, must not shift layout — it is `position: fixed` — and
  must not regress the landing Lighthouse score or CLS; it loads its data after the page is idle).
- 2 s after the page becomes interactive and the tab is visible, he rises from below the bottom-right
  corner (`mood="peek"`), with a speech bubble beside him:
  - with a deal: «Привіт, я Ґеґе! Сьогодні **{name}** −{percent}% за {price} ₴.» — the name links to
    the game page, the price uses the existing price formatting;
  - second line, always: «Можу підібрати ще багато цікавих ігор — без довгого пошуку в каталозі.»
  - without a deal the first line is just «Привіт, я Ґеґе!»
  - English: "Hi, I'm Gege! Today **{name}** is −{percent}% at {price} ₴." / "I can pick many more
    games for you — without a long search through the catalog."
  - buttons: **«Давай»** (accent, links to `/ask`, locale-aware) and **«Не зараз»**.
- «Не зараз», Escape while focus is inside, or the close control hides the bubble; he sinks until
  only one grip shows in the corner as a small button («Ґеґе: AI-підбір»), which opens the bubble
  again. He does not rise by himself again in that browser session (`sessionStorage`, wrapped in
  try/catch; without storage he simply behaves as on a first visit).
- Accessibility: the bubble is a non-modal region (`role="complementary"` or a labelled `aside`),
  never steals focus, is reachable in tab order after the main content, is not announced as an
  alert; buttons are real `<a>`/`<button>` with visible focus; touch targets ≥ 44 px; text contrast
  AA. On a phone the bubble sits above him and never covers more than the bottom third of the
  screen; it must not overlap the Vercel-injected or footer controls badly.
- Reduced motion: he appears without the rise or sway.
- Bubble style: `surface-2` background, 1 px accent border, radius from the design tokens, Tektur
  only for his name if at all; body copy in the interface face.

## 5. `/ask`

- **Idle:** Gege (about 96 px wide, `mood="idle"`) beside a bubble: title «Опиши гру, як сказав би
  другові» (en: "Describe the game the way you'd tell a friend"), text «Жанр, настрій, з ким граєш,
  скільки готовий витратити. Я знайду ігри й поясню, чому саме вони.» (en: "Genre, mood, who you
  play with, how much you'd spend. I'll find the games and say why these ones."). Below: the input
  with the submit button **«Підібрати»** / "Pick games", the character counter, the three example
  chips (as his suggestions), the privacy note. One `h1` on the page stays (visually it may be the
  bubble title).
- **The form never disappears.** With an answer on screen the question stays in the input above it,
  editable, and can be resubmitted.
- **Waiting:** Gege `mood="thinking"` and a line that changes with elapsed time, announced politely
  once (`aria-live="polite"`, not on every change): «Читаю запит…» (0 s) → «Шукаю ігри…» (2 s) →
  «Пояснюю вибір…» (4 s) (en: "Reading your request…" / "Looking for games…" / "Explaining the
  picks…"). These are time-based, not real progress; do not claim otherwise in code comments.
- **Answer:** Gege (about 44 px, `mood="happy"` once, then idle) with a bubble: the interpretation
  in his voice — «Зрозумів так: {interpretation}» — then the understood filter chips and the
  «Відкрити в каталозі» link, then the count line. The existing notes (indexed-only, stale,
  ignored filters, fallback) keep their meaning and move inside or directly under the bubble; in
  fallback mode he says the existing fallback sentence.
- **Results as rows, not big cards:** each game is one row — cover thumbnail (existing image
  sizing rules), name (link to the game page), meta (year, platforms, Metacritic badge), price with
  discount on the right, and the **reason as the primary line** under the name in `text-fg`
  (not small grey). Without a reason the row simply has none. Rows stack on phones (price under the
  meta). All eight rows must be present in the DOM — see the bug below.
- **Bug to fix:** production shows "Підібрали 8 ігор" above four visible games in an ~800 px-wide
  window for «кооператив для двох на Switch до 500 грн». Find the cause (count vs. rendered items,
  or items hidden by layout/lazy rendering) and fix it; add a test that the number in the count
  line equals the number of rendered results.
- Empty, error and rate-limit states keep their copy; Gege shows `idle` beside them.

## Copy

All copy lives in `i18n/locales/{uk,en}.json`. On the ask page and in the greeter all copy is
informal: Gege speaks in the first person and addresses the visitor as «ти» everywhere on `/ask` —
his bubbles, the form's label, the example caption, the count line («Підібрав {count} …», in
fallback «Знайшов {count} …»; English "Picked/Found {count} game(s)"), the privacy note, the empty
state and every error text. The ask page's document title and `description` meta are not his
speech and stay formal. The rest of the site's copy is not changed.

## Constraints

- English only in code, comments, tests, commit messages and docs; Ukrainian only in the uk locale
  file.
- Strict CSP stays: no inline scripts or styles beyond what the build already hashes; check
  `pnpm check:vercel-headers` if anything under `<head>` changes.
- The `/games` JavaScript budget (`pnpm check:bundle-budget`) must still pass; the mascot and the
  greeter must not be in the `/games` first load beyond the header face.
- Tests: component tests for the mascot moods (static render + reduced motion), the greeter
  (timer, dismissal, session memory, no deal), the resolver (`dealOfTheDay` selection, null cases,
  determinism by date), the ask page states, and the e2e/axe flows kept green
  (`pnpm e2e` in fixture mode if it covers `/` and `/ask`).
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` must pass.

## Out of scope

Chat-style follow-up questions, a mascot on catalog or game pages, sound, model-written greetings.
