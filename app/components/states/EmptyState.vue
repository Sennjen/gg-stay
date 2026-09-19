<script setup lang="ts">
defineProps<{ activeCount: number }>()
defineEmits<{ clear: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="rounded-card border border-dashed border-line p-10 text-center">
    <h2 class="font-display-heading text-xl text-fg">{{ t('states.emptyTitle') }}</h2>
    <p class="mt-2 text-fg-2">{{ t('states.emptyHint') }}</p>
    <button
      v-if="activeCount > 0"
      type="button"
      class="mt-6 rounded-chip bg-accent px-4 py-2 text-on-accent focus-visible:outline-2"
      @click="$emit('clear')"
    >
      {{ t('states.clearFilters') }}
    </button>
  </div>
</template>
