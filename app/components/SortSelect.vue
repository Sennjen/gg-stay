<script setup lang="ts">
import { UI_SORTS, type GameSortValue } from '#shared/catalog'

defineProps<{ modelValue: GameSortValue }>()
const emit = defineEmits<{ 'update:modelValue': [value: GameSortValue] }>()
const { t } = useI18n()
</script>

<template>
  <label class="flex items-center gap-2 text-sm text-fg-2">
    <span class="hidden sm:inline">{{ t('catalog.sort') }}</span>
    <select
      :value="modelValue"
      :aria-label="t('catalog.sort')"
      class="rounded-chip border border-line bg-surface-1 px-3 py-1.5 text-sm text-fg focus-visible:outline-2"
      @change="
        emit('update:modelValue', ($event.target as HTMLSelectElement).value as GameSortValue)
      "
    >
      <option v-for="sort in UI_SORTS" :key="sort" :value="sort">{{ t(`sorts.${sort}`) }}</option>
    </select>
  </label>
</template>
