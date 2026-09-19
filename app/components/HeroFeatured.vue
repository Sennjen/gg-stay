<script setup lang="ts">
import type { LandingQuery } from '~/graphql/__generated__/operations'

const props = defineProps<{ featured: LandingQuery['landing']['featured'] }>()
const { t } = useI18n()
const localePath = useLocalePath()

const paused = ref(false)
const poster = computed(() => props.featured?.game.cover ?? null)
const clipUrl = computed(() => props.featured?.clipUrl ?? null)
</script>

<template>
  <section
    class="relative flex min-h-[560px] w-full items-end overflow-hidden bg-ink pt-[var(--header-h)]"
    style="height: 100vh; height: 100svh"
  >
    <NuxtImg
      v-if="poster"
      :src="poster.url"
      alt=""
      width="1280"
      height="720"
      sizes="100vw"
      loading="eager"
      fetchpriority="high"
      preload
      class="hero-poster absolute inset-0 h-full w-full object-cover"
      :class="{ 'hero-poster--paused': paused }"
    />

    <ClientOnly v-if="clipUrl">
      <HeroVideo v-model:paused="paused" :clip-url="clipUrl" />
    </ClientOnly>

    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink via-ink/50 to-transparent"
    />
    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 bg-gradient-to-r from-ink/85 via-ink/10 to-transparent"
    />

    <div class="relative z-10 mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6 sm:pb-20">
      <h1
        class="font-display-heading text-balance text-[clamp(2.75rem,7vw,5.5rem)] leading-[0.95] text-fg"
      >
        {{ t('home.hero.headline') }}
      </h1>
      <p class="mt-4 max-w-md text-lg text-fg-2">{{ t('home.hero.lead') }}</p>
      <div class="mt-8 flex flex-wrap items-center gap-6">
        <NuxtLink
          :to="localePath('/games')"
          class="rounded-chip bg-accent px-6 py-3 font-medium text-on-accent focus-visible:outline-2"
        >
          {{ t('home.hero.openCatalog') }}
        </NuxtLink>
        <NuxtLink
          :to="{ path: localePath('/games'), query: { sort: 'RELEASED_DESC' } }"
          class="text-sm text-fg underline-offset-4 hover:underline focus-visible:outline-2"
        >
          {{ t('home.hero.newReleases') }}
        </NuxtLink>
      </div>
    </div>

    <i18n-t
      v-if="featured"
      keypath="home.hero.nowOnScreen"
      tag="p"
      class="absolute bottom-4 right-4 z-10 max-w-[65%] text-right text-sm text-signal sm:bottom-6 sm:right-6"
    >
      <template #title>
        <NuxtLink
          :to="localePath(`/games/${featured.game.slug}`)"
          class="underline underline-offset-4 focus-visible:outline-2"
        >
          {{ featured.game.name }}
        </NuxtLink>
      </template>
    </i18n-t>
  </section>
</template>

<style scoped>
/* Slow zoom on the poster when there is no video (or before it appears). 20-30s range per the
   design doc; `alternate infinite` gives a gentle zoom in/out instead of a hard reset. The
   `paused` class (driven by the HeroVideo toggle) is the explicit reduced-motion-style branch
   this loop needs per DESIGN.md; on top of that, the global `prefers-reduced-motion` rule in
   main.css collapses every animation's duration to ~0 with `!important`, so under reduced
   motion the zoom never becomes visible even without the toggle being touched. */
.hero-poster {
  animation: hero-ken-burns 26s ease-out infinite alternate;
}

.hero-poster--paused {
  animation-play-state: paused;
}

@keyframes hero-ken-burns {
  from {
    transform: scale(1);
  }
  to {
    transform: scale(1.08);
  }
}

@media (prefers-reduced-motion: reduce) {
  .hero-poster {
    animation: none;
  }
}
</style>
