<script setup lang="ts" generic="T extends string | number">
const props = defineProps<{
  legend: string
  options: { value: T; label: string }[]
  modelValue: T[]
}>()
const emit = defineEmits<{ 'update:modelValue': [value: T[]] }>()

function toggle(value: T, checked: boolean) {
  const next = checked
    ? [...props.modelValue, value]
    : props.modelValue.filter((entry) => entry !== value)
  emit('update:modelValue', next)
}
</script>

<template>
  <FiltersFilterGroup :legend="legend">
    <label v-for="option in options" :key="option.value" class="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        :checked="modelValue.includes(option.value)"
        class="size-4 accent-accent focus-visible:outline-2"
        @change="toggle(option.value, ($event.target as HTMLInputElement).checked)"
      />
      {{ option.label }}
    </label>
  </FiltersFilterGroup>
</template>
