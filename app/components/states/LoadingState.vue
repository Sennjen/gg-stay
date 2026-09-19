<script setup lang="ts">
withDefaults(defineProps<{ count?: number }>(), { count: 8 })
const { t } = useI18n()
</script>

<template>
  <div
    aria-busy="true"
    :aria-label="t('states.loading')"
    class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
  >
    <div
      v-for="index in count"
      :key="index"
      data-test="skeleton"
      class="overflow-hidden rounded-card border border-line bg-surface-1"
    >
      <div class="aspect-video w-full bg-surface-2 motion-safe:animate-pulse" />
      <div class="space-y-2 p-3">
        <div class="h-4 w-3/4 rounded bg-surface-2 motion-safe:animate-pulse" />
        <div class="h-3 w-1/3 rounded bg-surface-2 motion-safe:animate-pulse" />
      </div>
    </div>
  </div>
</template>
