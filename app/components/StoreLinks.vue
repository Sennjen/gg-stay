<script setup lang="ts">
import { STORE_OPTIONS } from '#shared/catalog'

defineProps<{ offers: { store: string; url: string }[] }>()
const { t } = useI18n()
const storeName = (slug: string) =>
  STORE_OPTIONS.find((option) => option.slug === slug)?.name ?? slug
</script>

<template>
  <section v-if="offers.length" aria-labelledby="where-to-buy">
    <h2 id="where-to-buy" class="font-display-heading text-xl text-fg">
      {{ t('game.whereToBuy') }}
    </h2>
    <ul class="mt-3 flex flex-wrap gap-2">
      <li v-for="offer in offers" :key="offer.store">
        <a
          :href="offer.url"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-block rounded-chip border border-line bg-surface-1 px-3 py-1.5 text-sm text-fg hover:bg-surface-2 focus-visible:outline-2"
        >
          {{ storeName(offer.store) }}
        </a>
      </li>
    </ul>
  </section>
</template>
