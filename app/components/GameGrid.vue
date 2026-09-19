<script setup lang="ts">
import type { GamesQuery } from '~/graphql/__generated__/operations'

withDefaults(defineProps<{ games: GamesQuery['games']['items']; layout?: 'grid' | 'list' }>(), {
  layout: 'grid',
})
</script>

<template>
  <ul
    class="grid gap-4"
    :class="
      layout === 'list' ? 'grid-cols-1' : 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'
    "
  >
    <!-- `index < 5` eagerly loads the first row for the widest grid layout (5 columns,
         `xl:grid-cols-5`), which is also the layout the LCP element sits in on desktop. On a
         2-column phone that over-fetches — it eagerly loads what is really the first two and a
         half rows — but there is no `sizes`-aware way to pick the eager count without measuring
         the rendered layout in JS (this is a server-rendered list: no client measurement has run
         yet on first paint), and this pass is not the place to add that measurement. Erring wide
         keeps desktop LCP correct, which is the one case a regression here would actually hurt. -->
    <li v-for="(game, index) in games" :key="game.id" class="h-full">
      <GameCard :game="game" :eager="index < 5" :layout="layout" :heading-level="2" />
    </li>
  </ul>
</template>
