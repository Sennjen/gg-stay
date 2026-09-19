<script setup lang="ts" generic="T extends string | number">
/** Multi-select group of toggle chips. The visible heading is provided by the
 * surrounding `FilterSection`; `legend` only names the group for assistive tech. */
const props = defineProps<{
  legend: string
  options: { value: T; label: string }[]
  modelValue: T[]
}>()
const emit = defineEmits<{ 'update:modelValue': [value: T[]] }>()

function toggle(value: T) {
  const checked = props.modelValue.includes(value)
  const next = checked
    ? props.modelValue.filter((entry) => entry !== value)
    : [...props.modelValue, value]
  emit('update:modelValue', next)
}
</script>

<template>
  <div role="group" :aria-label="legend" class="flex flex-wrap gap-2">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      :aria-pressed="modelValue.includes(option.value)"
      class="rounded-chip border px-3 py-1.5 text-sm focus-visible:outline-2"
      :class="
        modelValue.includes(option.value)
          ? 'border-accent bg-accent text-on-accent'
          : 'border-line bg-surface-1 text-fg-2 hover:text-fg'
      "
      @click="toggle(option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>
