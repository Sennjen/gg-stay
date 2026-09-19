<script setup lang="ts">
defineProps<{ page: number; hasNext: boolean }>()
defineEmits<{ change: [page: number] }>()
const { t } = useI18n()
</script>

<template>
  <nav
    class="mt-8 flex items-center justify-center gap-4"
    :aria-label="t('catalog.page', { page })"
  >
    <button
      type="button"
      :disabled="page <= 1"
      class="rounded-chip border border-line bg-surface-1 px-4 py-2 text-fg disabled:opacity-40 focus-visible:outline-2"
      @click="$emit('change', page - 1)"
    >
      {{ t('catalog.prev') }}
    </button>
    <span aria-current="page" class="font-numeric text-fg">{{ t('catalog.page', { page }) }}</span>
    <button
      type="button"
      :disabled="!hasNext"
      class="rounded-chip border border-line bg-surface-1 px-4 py-2 text-fg disabled:opacity-40 focus-visible:outline-2"
      @click="$emit('change', page + 1)"
    >
      {{ t('catalog.next') }}
    </button>
  </nav>
</template>
