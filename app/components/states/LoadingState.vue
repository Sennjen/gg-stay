<script setup lang="ts">
withDefaults(defineProps<{ count?: number }>(), { count: 8 })
const { t } = useI18n()
</script>

<template>
  <div
    aria-busy="true"
    :aria-label="t('states.loading')"
    class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4"
  >
    <div
      v-for="index in count"
      :key="index"
      data-test="skeleton"
      class="aspect-[3/4] rounded-card bg-surface-2 motion-safe:animate-pulse"
    />
  </div>
</template>
