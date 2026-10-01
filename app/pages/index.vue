<script setup lang="ts">
import { LandingDocument } from '~/graphql/__generated__/operations'
import { RING_HEIGHT_CLASS } from '~/components/CoverRing.vue'
import { roundGameCount } from '~/utils/roundGameCount'
import { shelfCatalogQuery, shelfDefinition } from '#shared/shelves'
import { INDEXABLE, OG_IMAGE } from '~/utils/seo'
import { serializeJsonLd, websiteJsonLd } from '~/utils/structuredData'

const { t, localeProperties } = useI18n()
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

// Every shelf the answer kept, in its order: the answer already left out the ones with too few
// games, and the ones the index could not serve. The title, the catalog URL behind the link and,
// where "Усі ігри" would promise more than the link gives, the link's own label all come from
// `shared/shelves.ts` — the same definition the resolver filled the shelf from. The year in a link
// is the one the answer says the shelves were built for, so this page reads no clock at all. A
// shelf this build has no definition for (a newer API during a deploy) is skipped, not fatal.
const shelves = computed(() => {
  const answer = landing.value
  if (!answer) return []
  return answer.shelves.flatMap((shelf) => {
    const definition = shelfDefinition(shelf.id)
    if (!definition) return []
    return [
      {
        id: shelf.id,
        title: t(definition.titleKey),
        games: shelf.games,
        moreTo: { path: localePath('/games'), query: shelfCatalogQuery(shelf.id, answer.year) },
        moreLabel: definition.moreLabelKey ? t(definition.moreLabelKey) : undefined,
      },
    ]
  })
})

const { absoluteUrl } = useSiteUrl()
const robots = useRobots()

// The landing keeps its own title ("GG Stay — …") rather than the "… — GG Stay" every other page
// ends with. Its share image is a static card of its own (`public/og.png`, drawn by
// `scripts/og-image.ts`): the featured game changes daily, and a link shared once should not
// preview as whatever game happened to be featured when a crawler fetched it.
useSeoMeta({
  title: () => t('home.title'),
  description: () => t('home.description'),
  robots: robots(INDEXABLE),
  ogTitle: () => t('home.title'),
  ogDescription: () => t('home.description'),
  ogImage: absoluteUrl(OG_IMAGE.path),
  ogImageWidth: OG_IMAGE.width,
  ogImageHeight: OG_IMAGE.height,
  ogImageType: 'image/png',
  ogImageAlt: () => t('home.shareImageAlt'),
})

useHead({
  script: () => [
    {
      key: 'ld-website',
      type: 'application/ld+json',
      innerHTML: serializeJsonLd(
        websiteJsonLd({
          homeUrl: absoluteUrl(localePath('/')),
          catalogUrl: absoluteUrl(localePath('/games')),
          description: t('home.description'),
          inLanguage: localeProperties.value.language ?? 'uk-UA',
        }),
      ),
    },
  ],
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
        :more-label="shelf.moreLabel"
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
