<script setup lang="ts">
import { INDEX_GAME_COUNT } from '#shared/catalog'
import { hoursSince } from '~/utils/format'

/**
 * What the visitor is told when the price index — not RAWG — answered the page: the search only
 * covers the games the index knows, and how old the prices in it are.
 *
 * `now` is passed in rather than read here: the page computes it once (on the server, or on the
 * first client render) and hands the same value to every render, so the hour count in the server
 * HTML and the hydrated one can never disagree. Nothing in this component reads a clock.
 */
const props = defineProps<{ updatedAt?: string | null; now: string }>()
const { t } = useI18n()
const { formatNumber } = useFormatters()

const hours = computed(() => hoursSince(props.updatedAt, props.now))
</script>

<template>
  <div data-test="index-note" class="space-y-0.5">
    <i18n-t keypath="catalog.indexedOnlyNote" tag="p" class="text-sm text-fg-2">
      <template #count
        ><span class="font-numeric">{{ formatNumber(INDEX_GAME_COUNT) }}</span></template
      >
    </i18n-t>
    <p v-if="hours === 0" data-test="prices-updated" class="text-xs text-fg-2">
      {{ t('catalog.pricesUpdatedRecently') }}
    </p>
    <i18n-t
      v-else-if="hours !== null"
      keypath="catalog.pricesUpdated"
      tag="p"
      :plural="hours"
      data-test="prices-updated"
      class="text-xs text-fg-2"
    >
      <template #count
        ><span class="font-numeric">{{ hours }}</span></template
      >
    </i18n-t>
  </div>
</template>
