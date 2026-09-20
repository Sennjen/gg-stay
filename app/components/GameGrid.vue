<script setup lang="ts">
import type { GamesQuery } from '~/graphql/__generated__/operations'

withDefaults(defineProps<{ games: GamesQuery['games']['items']; layout?: 'grid' | 'list' }>(), {
  layout: 'grid',
})

// The narrowest layout that matters is the two-column phone grid, and that is what the eager count
// is set to. Above it the first row holds 3, 4 or 5 cards, but those cards are in the server's
// HTML from the first byte and sit inside the viewport, where `loading="lazy"` is not a deferral:
// browsers fetch in-viewport lazy images during the initial load. Eagerly loading five covers to
// cover the widest grid meant a 360px phone started 2.5 rows of images alongside its own LCP
// candidate, which is the one case where a mistake here actually costs something.
//
// The first cover additionally gets `fetchpriority="high"`: on this route it is the LCP element,
// and the hint is what puts it ahead of the rest of the row in the browser's own queue.
const EAGER_COVERS = 2
</script>

<template>
  <ul
    class="grid gap-4"
    :class="
      layout === 'list' ? 'grid-cols-1' : 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'
    "
  >
    <li v-for="(game, index) in games" :key="game.id" class="h-full">
      <GameCard
        :game="game"
        :eager="index < EAGER_COVERS"
        :priority="index === 0"
        :layout="layout"
        :heading-level="2"
      />
    </li>
  </ul>
</template>
