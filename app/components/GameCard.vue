<script setup lang="ts">
import type { GamesQuery } from '~/graphql/__generated__/operations'
import { CARD_GRID_IMAGE_SIZES, CARD_LIST_IMAGE_SIZES } from '~/utils/rawgImage'

const props = withDefaults(
  defineProps<{
    game: GamesQuery['games']['items'][number]
    eager?: boolean
    layout?: 'grid' | 'list'
    /** The card title's heading level, so callers can keep a sane outline: `GameRow` nests
     * cards under its own `<h2>` (so cards stay `<h3>`, the default), while `GameGrid` on the
     * catalog page sits directly under the page's `<h1>` with no heading in between. */
    headingLevel?: 2 | 3
    /** Overrides the cover's `sizes` for callers whose slot is not the catalog grid's — the
     * landing rows render grid-layout cards at a fixed width (see `CARD_ROW_IMAGE_SIZES`). */
    coverSizes?: string
    /** Marks this cover as the page's LCP candidate: `fetchpriority="high"` plus eager loading. */
    priority?: boolean
  }>(),
  { eager: false, layout: 'grid', headingLevel: 3, coverSizes: undefined, priority: false },
)
const titleTag = computed(() => `h${props.headingLevel}` as const)
const { t } = useI18n()
const localePath = useLocalePath()

const YEAR = /^(\d{4})-\d{2}-\d{2}/
const year = computed(() => props.game.released?.match(YEAR)?.[1] ?? null)
const previewUrl = computed(() => props.game.screenshots[0]?.url ?? null)

// A game outside the week-2 index has neither a price nor a localisation flag: the whole line is
// omitted (not a placeholder), so an unpriced card among priced ones is exactly as tall as before.
const hasPriceLine = computed(
  () => !!props.game.price || !!(props.game.localisation?.text || props.game.localisation?.audio),
)

// Grid markup/classes stay byte-identical to before this prop existed; list only adds a
// horizontal layout at >= 640px (cover ~220px wide, stacked like grid below that) and asks
// the browser for a narrower image instead of the grid's ~420px variant. Explicit width/height
// and the eager/lazy and hover/focus-preview rules below are unchanged in both layouts.
const linkClass = computed(() =>
  props.layout === 'list'
    ? 'group flex h-full flex-col overflow-hidden rounded-card border border-line bg-surface-1 transition-colors duration-200 ease-out hover:border-fg-2 focus-visible:border-fg-2 focus-visible:outline-2 sm:flex-row'
    : 'group flex h-full flex-col overflow-hidden rounded-card border border-line bg-surface-1 transition-colors duration-200 ease-out hover:border-fg-2 focus-visible:border-fg-2 focus-visible:outline-2',
)
const coverWrapperClass = computed(() =>
  props.layout === 'list'
    ? 'relative aspect-video w-full shrink-0 overflow-hidden bg-surface-2 sm:w-[220px]'
    : 'relative aspect-video w-full shrink-0 overflow-hidden bg-surface-2',
)
// `@nuxt/image` breakpoint syntax, not CSS media queries — see app/utils/rawgImage.ts.
const coverSizes = computed(
  () =>
    props.coverSizes ?? (props.layout === 'list' ? CARD_LIST_IMAGE_SIZES : CARD_GRID_IMAGE_SIZES),
)

// The second image is a "does this look interesting?" preview, not core content: it only
// starts loading once the user shows intent (pointer hover or keyboard focus), so a full grid
// of visible cards never fetches a screenshot per card on first paint. `loading="lazy"` alone
// would not do this — it only defers until near-viewport, which is true for every visible
// card. Touch has no hover intent, so a touch tap is ignored here (`eager`-style cover loading
// already gets those users the cover; the game page has the real screenshot gallery).
const showPreview = ref(false)
const previewLoaded = ref(false)
function revealPreview(event: PointerEvent) {
  if (event.pointerType === 'touch') return
  showPreview.value = true
}
</script>

<template>
  <article data-test="game-card" class="h-full overflow-hidden rounded-card">
    <NuxtLink
      :to="localePath(`/games/${game.slug}`)"
      :class="linkClass"
      @pointerenter="revealPreview"
      @focus="showPreview = true"
    >
      <div :class="coverWrapperClass">
        <NuxtImg
          v-if="game.cover"
          :src="game.cover.url"
          :alt="game.name"
          width="420"
          height="236"
          :sizes="coverSizes"
          :loading="props.eager || props.priority ? 'eager' : 'lazy'"
          :fetchpriority="props.priority ? 'high' : undefined"
          class="h-full w-full object-cover transition-transform duration-200 ease-out group-hover:scale-[1.03] group-focus-visible:scale-[1.03]"
        />
        <div v-else class="flex h-full w-full items-center justify-center text-sm text-fg-2">
          {{ t('catalog.noCover') }}
        </div>
        <NuxtImg
          v-if="showPreview && previewUrl"
          :src="previewUrl"
          alt=""
          aria-hidden="true"
          width="420"
          height="236"
          :sizes="coverSizes"
          loading="lazy"
          class="absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-200 ease-out"
          :class="previewLoaded ? 'group-hover:opacity-100 group-focus-visible:opacity-100' : ''"
          @load="previewLoaded = true"
        />
      </div>
      <div class="flex flex-1 flex-col p-3">
        <component
          :is="titleTag"
          data-test="card-title"
          class="line-clamp-2 min-h-[2.75rem] font-semibold leading-snug text-fg"
        >
          {{ game.name }}
        </component>
        <div
          v-if="year || game.metacritic || game.platformFamilies.length || hasPriceLine"
          class="@container mt-auto pt-2"
        >
          <!-- A `<div>`, not a `<p>`: `PlatformIcons` in `responsive` mode renders `<ul>`
               elements, and `<ul>` is block content that HTML forbids inside `<p>` — a browser
               parsing the server's HTML string auto-closes an open `<p>` the moment it reaches
               that first `<ul>` (even nested a level or two deeper), silently hoisting it out as
               a following sibling. That restructures the server-parsed DOM before Vue ever gets
               to it, so hydration walks a different tree than the one it rendered and warns of a
               mismatch — reproducible with plain `@vue/server-renderer` + no app code at all,
               nothing Vue- or Nuxt-specific to fix on that side. -->
          <div
            v-if="year || game.platformFamilies.length"
            class="flex flex-nowrap items-center gap-1 overflow-hidden text-sm text-fg-2"
          >
            <span v-if="year" class="font-numeric shrink-0">{{ year }}</span>
            <span v-if="year && game.platformFamilies.length" aria-hidden="true" class="shrink-0"
              >·</span
            >
            <PlatformIcons
              v-if="game.platformFamilies.length"
              :families="game.platformFamilies"
              responsive
            />
          </div>
          <p v-if="game.metacritic" class="mt-1 flex flex-nowrap items-center overflow-hidden">
            <MetacriticBadge :score="game.metacritic" caption />
          </p>
          <div v-if="hasPriceLine" class="mt-1.5 flex items-center justify-between gap-2">
            <PriceTag :price="game.price" />
            <LocalisationBadge :localisation="game.localisation" />
          </div>
        </div>
      </div>
    </NuxtLink>
  </article>
</template>
