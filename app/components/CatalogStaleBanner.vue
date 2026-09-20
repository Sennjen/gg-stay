<script setup lang="ts">
/**
 * Shown above the grid when the index's prices are too old to trust. A stale price is worse than
 * none, so prices are withheld and the price filters and sorts are taken off the page — which is
 * a change a visitor would otherwise have to guess at, hence the sentence saying so.
 */
const { t } = useI18n()
</script>

<template>
  <div
    data-test="stale-banner"
    role="status"
    class="rounded-card border border-line bg-surface-1 p-4"
  >
    <p class="text-sm font-semibold text-fg">{{ t('catalog.staleTitle') }}</p>
    <p class="mt-1 text-sm text-fg-2">{{ t('catalog.staleBody') }}</p>
  </div>
</template>
