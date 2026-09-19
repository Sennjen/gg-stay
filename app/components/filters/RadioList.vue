<script setup lang="ts" generic="T extends string | number">
defineProps<{
  legend: string
  name: string
  options: { value: T; label: string }[]
  modelValue: T | undefined
}>()
const emit = defineEmits<{ 'update:modelValue': [value: T | undefined] }>()
const { t } = useI18n()
</script>

<template>
  <FiltersFilterGroup :legend="legend">
    <label class="flex items-center gap-2 text-sm">
      <input
        type="radio"
        :name="name"
        :checked="modelValue === undefined"
        class="size-4 focus-visible:outline-2"
        @change="emit('update:modelValue', undefined)"
      />
      {{ t('catalog.any') }}
    </label>
    <label v-for="option in options" :key="option.value" class="flex items-center gap-2 text-sm">
      <input
        type="radio"
        :name="name"
        :checked="modelValue === option.value"
        class="size-4 focus-visible:outline-2"
        @change="emit('update:modelValue', option.value)"
      />
      {{ option.label }}
    </label>
  </FiltersFilterGroup>
</template>
