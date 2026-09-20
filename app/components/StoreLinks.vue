<script setup lang="ts">
import { STORE_OPTIONS } from '#shared/catalog'
import { safeExternalUrl } from '#shared/url'

const props = defineProps<{
  offers: {
    store: string
    url: string
    priceUah?: number | null
    discountPercent?: number | null
  }[]
}>()
const { t } = useI18n()
const { formatUah } = useFormatters()
const storeName = (slug: string) =>
  STORE_OPTIONS.find((option) => option.slug === slug)?.name ?? slug

// The mapper already refuses anything that is not http(s) (server/rawg/mappers.ts), so this is
// defence in depth: the scheme check sits next to the `:href` it protects, where a future
// refactor that changes the data source cannot silently drop it.
const safeOffers = computed(() =>
  props.offers.flatMap((offer) => {
    const url = safeExternalUrl(offer.url)
    return url ? [{ ...offer, url }] : []
  }),
)
</script>

<template>
  <section v-if="safeOffers.length" aria-labelledby="where-to-buy">
    <h2 id="where-to-buy" class="font-display-heading text-xl text-fg">
      {{ t('game.whereToBuy') }}
    </h2>
    <ul class="mt-3 flex flex-wrap gap-2">
      <li v-for="offer in safeOffers" :key="offer.store">
        <a
          :href="offer.url"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1.5 rounded-chip border border-line bg-surface-1 px-3 py-1.5 text-sm text-fg transition-colors duration-200 ease-out hover:bg-surface-2 focus-visible:outline-2"
        >
          {{ storeName(offer.store) }}
          <template v-if="offer.priceUah != null">
            <span aria-hidden="true">·</span>
            <span class="font-numeric">{{ formatUah(offer.priceUah) }}</span>
            <span v-if="offer.discountPercent" class="font-numeric"
              >−{{ offer.discountPercent }}%</span
            >
          </template>
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
