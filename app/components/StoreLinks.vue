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
          class="inline-flex items-center gap-1.5 rounded-chip border border-line bg-surface-1 px-3 py-1.5 text-sm text-fg transition-colors duration-200 ease-out hover:bg-surface-2 focus-visible:outline-2"
        >
          {{ storeName(offer.store) }}
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M6.5 3.5h6v6" />
            <path d="M12.5 3.5 6 10" />
            <path d="M9.5 3.5h-5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-5" />
          </svg>
        </a>
      </li>
    </ul>
  </section>
</template>
