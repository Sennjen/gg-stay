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
    <li v-for="(game, index) in games" :key="game.id" class="h-full">
      <GameCard :game="game" :eager="index < 5" :layout="layout" />
    </li>
  </ul>
</template>
