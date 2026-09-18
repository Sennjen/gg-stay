<script setup lang="ts">
import type { GamesQuery } from '~/graphql/__generated__/operations'

defineProps<{ games: GamesQuery['games']['items'] }>()
</script>

<template>
  <ul class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
    <li v-for="game in games" :key="game.id">
      <GameCard :game="game" />
    </li>
  </ul>
</template>
