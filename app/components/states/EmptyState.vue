<script setup lang="ts">
defineProps<{ activeCount: number }>()
defineEmits<{ clear: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="rounded-lg border border-dashed border-slate-300 p-10 text-center">
    <h2 class="text-xl font-semibold">{{ t('states.emptyTitle') }}</h2>
    <p class="mt-2 text-slate-600">{{ t('states.emptyHint') }}</p>
    <button
      v-if="activeCount > 0"
      type="button"
      class="mt-6 rounded bg-slate-900 px-4 py-2 text-white focus-visible:outline-2"
      @click="$emit('clear')"
    >
      {{ t('states.clearFilters') }}
    </button>
  </div>
</template>
