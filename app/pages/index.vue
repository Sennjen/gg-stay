<script setup lang="ts">
import { LandingDocument } from '~/graphql/__generated__/operations'
import { RING_HEIGHT_CLASS } from '~/components/CoverRing.vue'
import { roundGameCount } from '~/utils/roundGameCount'
import { shelfCatalogQuery, shelfDefinition } from '#shared/shelves'

const { t } = useI18n()
const { formatNumber } = useFormatters()
const localePath = useLocalePath()

// A failed landing query must not surface an error box on the landing page — the hero still
// renders with the headline and call to action over the plain `ink` background, just without a
// featured game. `errorCode`/`status` are intentionally unused here (not logged, not shown).
const { data } = await useGql(LandingDocument, {})

const featured = computed(() => data.value?.landing?.featured ?? null)

// The stats + ring section needs real landing data (the count and the carousel); when the query
// failed, `landing` is null and this whole section is simply absent — no placeholder, no error
// box. The shelves fall back to none the same way.
const landing = computed(() => data.value?.landing ?? null)
// `null` when the total is too small to round to a friendly figure; the headline is hidden then.
const roundedCount = computed(() =>
  landing.value ? roundGameCount(landing.value.totalGames) : null,
)
const formattedCount = computed(() =>
  roundedCount.value === null ? '' : formatNumber(roundedCount.value),
)

// The "Найкращі цього року" link needs the calendar year. Read once — on the server, carried to
// the client in the payload — so the link in the server HTML and the hydrated one never differ,
// and nothing in the render path reads a clock. UTC, like the resolver's own `today`.
const year = useState('landing-year', () => new Date().getUTCFullYear())

// Every shelf the answer kept, in its order: the answer already left out the ones with too few
// games, and the ones the index could not serve. The title and the catalog URL behind "Усі ігри"
// both come from `shared/shelves.ts`, the same definition the resolver filled the shelf from.
const shelves = computed(() =>
  (landing.value?.shelves ?? []).map((shelf) => ({
    id: shelf.id,
    title: t(shelfDefinition(shelf.id).titleKey),
    games: shelf.games,
    moreTo: { path: localePath('/games'), query: shelfCatalogQuery(shelf.id, year.value) },
  })),
)

useSeoMeta({
  title: () => t('home.title'),
  description: () => t('home.description'),
  ogTitle: () => t('home.title'),
  ogDescription: () => t('home.description'),
  // The featured game's cover doubles as the social preview: it is already the hero, already
  // fetched, and it changes with the featured game rather than going stale as a static asset.
  ogImage: () => featured.value?.game.cover?.url ?? undefined,
})

// Full-bleed breakout: the layout's container (app/layouts/default.vue) centers content at
// `max-w-6xl` with side and top padding, which is right for every other page but would clip the
// hero to that width. The layout is shared with every other route, which needs that container, so
// the horizontal breakout is done here instead: standard "full-bleed" CSS (viewport-relative
// offsets, not the parent's).
//
// The hero must also run UNDERNEATH the sticky transparent header, not start below it.
// `AppHeader` is `position: sticky`, so at the top of the page it still occupies its normal flow
// height (`--header-h`, see app/assets/css/main.css) above the layout's container, which itself
// adds `py-6` (1.5rem) of top padding before this page's content starts. Pulling this wrapper up
// by exactly that combined space (`calc(var(--header-h) + 1.5rem)`) moves the hero's top edge to
// the very top of the document, so the header — transparent on this route — sits over the poster
// instead of above an empty `ink` bar. No JS measurement: both amounts are fixed, known at CSS
// time, and identical on server and client.
</script>

<template>
  <div>
    <!-- A plain `<div>`, not a landmark: the layout's `<main id="main-content">` already wraps
         this page, hero included, so the skip link lands above the hero rather than on it. -->
    <div
      data-test="hero-bleed"
      class="relative left-1/2 right-1/2 -mt-[calc(var(--header-h)+1.5rem)] w-screen -ml-[50vw] -mr-[50vw]"
    >
      <HeroFeatured :featured="featured" />
    </div>

    <div class="mt-16 flex flex-col gap-16 sm:mt-24 sm:gap-24">
      <section v-if="landing" class="text-center">
        <i18n-t
          v-if="roundedCount !== null"
          keypath="home.stats.title"
          tag="h2"
          class="font-display-heading text-2xl text-fg sm:text-3xl"
        >
          <template #count>
            <span class="font-numeric">{{ formattedCount }}</span>
          </template>
        </i18n-t>
        <ClientOnly>
          <CoverRing class="mt-8" :games="landing.carousel" :title="t('ring.scrollLabel')" />
          <template #fallback>
            <div class="mt-8" :class="RING_HEIGHT_CLASS" />
          </template>
        </ClientOnly>
      </section>

      <WhyCards />

      <GameRow
        v-for="shelf in shelves"
        :key="shelf.id"
        :data-test="`shelf-${shelf.id}`"
        :title="shelf.title"
        :games="shelf.games"
        :more-to="shelf.moreTo"
      />

      <section class="rounded-card border border-line bg-surface-1 px-6 py-12 text-center sm:py-16">
        <h2 class="font-display-heading text-2xl text-fg sm:text-3xl">{{ t('home.cta.title') }}</h2>
        <NuxtLink
          :to="localePath('/games')"
          class="mt-6 inline-block rounded-chip bg-accent px-6 py-3 font-medium text-on-accent focus-visible:outline-2"
        >
          {{ t('home.hero.openCatalog') }}
        </NuxtLink>
      </section>
    </div>
  </div>
</template>
