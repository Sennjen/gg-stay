<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import type { GamesQuery } from '~/graphql/__generated__/operations'

const props = defineProps<{
  title: string
  games: GamesQuery['games']['items']
  moreTo?: RouteLocationRaw
  moreLabel?: string
}>()

const { t } = useI18n()
const headingId = useId()

// These rows sit below the fold (the ring and "why" cards come first), so every
// card loads lazily — never `eager`, unlike the first row of the catalog grid.
</script>

<template>
  <section v-if="props.games.length" :aria-labelledby="headingId">
    <div class="flex items-baseline justify-between gap-4">
      <h2 :id="headingId" class="font-display-heading text-2xl text-fg sm:text-3xl">
        {{ props.title }}
      </h2>
      <NuxtLink
        v-if="props.moreTo"
        data-test="row-more-link"
        :to="props.moreTo"
        class="shrink-0 text-sm text-fg-2 transition-colors duration-200 ease-out hover:text-fg focus-visible:outline-2"
      >
        {{ props.moreLabel ?? t('rows.viewAll') }}
      </NuxtLink>
    </div>
    <ul class="row-scroll mt-4 flex gap-4 overflow-x-auto pb-2" role="list">
      <li v-for="game in props.games" :key="game.id" class="w-[280px] shrink-0 snap-start">
        <GameCard :game="game" :eager="false" />
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* A quiet horizontal scroller: snaps per card, keyboard-focusable cards scroll
   themselves into view natively, and the scrollbar is hidden so it never jitters
   the layout while still being fully operable by wheel, touch, drag and keyboard. */
.row-scroll {
  scroll-snap-type: x proximity;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.row-scroll::-webkit-scrollbar {
  display: none;
}
</style>
