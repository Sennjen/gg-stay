<script setup lang="ts">
import { LandingDocument } from '~/graphql/__generated__/operations'
import { RING_HEIGHT_CLASS } from '~/components/CoverRing.vue'
import { roundGameCount } from '~/utils/roundGameCount'

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
// box. `GameRow` below already renders nothing for an empty list, so the two rows need no
// matching guard: they fall back to `[]` and disappear on their own.
const landing = computed(() => data.value?.landing ?? null)
const formattedCount = computed(() =>
  landing.value ? formatNumber(roundGameCount(landing.value.totalGames)) : '',
)
const newReleasesTo = { path: localePath('/games'), query: { sort: 'RELEASED_DESC' } }
const topRatedTo = { path: localePath('/games'), query: { sort: 'RATING_DESC' } }

useSeoMeta({ title: () => t('home.title'), description: () => t('home.description') })

// Full-bleed breakout: the layout's container (app/layouts/default.vue) centers content at
// `max-w-6xl` with side and top padding, which is right for every other page but would clip the
// hero to that width. The layout is shared with other routes and out of scope for this PR, so the
// horizontal breakout is done here instead: standard "full-bleed" CSS (viewport-relative offsets,
// not the parent's).
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
    <main
      class="relative left-1/2 right-1/2 -mt-[calc(var(--header-h)+1.5rem)] w-screen -ml-[50vw] -mr-[50vw]"
    >
      <HeroFeatured :featured="featured" />
    </main>

    <div class="mt-16 flex flex-col gap-16 sm:mt-24 sm:gap-24">
      <section v-if="landing" class="text-center">
        <i18n-t
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
        :title="t('home.rows.newReleases')"
        :games="landing?.newReleases ?? []"
        :more-to="newReleasesTo"
      />
      <GameRow
        :title="t('home.rows.topRated')"
        :games="landing?.topRated ?? []"
        :more-to="topRatedTo"
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
