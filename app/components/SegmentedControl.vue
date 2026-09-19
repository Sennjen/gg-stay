<script setup lang="ts" generic="T extends string | number">
/**
 * Single-select control with radio-group semantics (arrow-key navigation, one
 * value at a time), always including an "any" option that maps to `undefined`.
 * Used for Metacritic and playtime; age rating stays multi-select (see
 * `FilterPanel`) and keeps the toggle-chip `CheckboxList` instead.
 */
const props = defineProps<{
  legend: string
  anyLabel: string
  options: { value: T; label: string }[]
  modelValue: T | undefined
}>()
const emit = defineEmits<{ 'update:modelValue': [value: T | undefined] }>()

const items = computed(() => [
  { value: undefined as T | undefined, label: props.anyLabel },
  ...props.options,
])
const buttonEls = ref<(HTMLButtonElement | null)[]>([])

function isSelected(value: T | undefined) {
  return props.modelValue === value
}

function select(value: T | undefined) {
  emit('update:modelValue', value)
}

const NAV_KEYS = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End']

function onKeydown(event: KeyboardEvent, index: number) {
  if (!NAV_KEYS.includes(event.key)) return
  event.preventDefault()
  const count = items.value.length
  let next = index
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % count
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + count) % count
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = count - 1
  select(items.value[next]!.value)
  nextTick(() => buttonEls.value[next]?.focus())
}
</script>

<template>
  <div role="radiogroup" :aria-label="legend" class="flex flex-wrap gap-2">
    <button
      v-for="(item, index) in items"
      :key="String(item.value)"
      :ref="(el) => (buttonEls[index] = el as HTMLButtonElement | null)"
      type="button"
      role="radio"
      :aria-checked="isSelected(item.value)"
      :tabindex="isSelected(item.value) ? 0 : -1"
      class="rounded-chip border px-3 py-1.5 text-sm focus-visible:outline-2"
      :class="
        isSelected(item.value)
          ? 'border-accent bg-accent text-on-accent'
          : 'border-line bg-surface-1 text-fg-2 hover:text-fg'
      "
      @click="select(item.value)"
      @keydown="onKeydown($event, index)"
    >
      {{ item.label }}
    </button>
  </div>
</template>
