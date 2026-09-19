<script setup lang="ts">
/** "Знайдено: {N}" with a 150ms tick when N changes; none under reduced motion (CSS only). */
const props = defineProps<{ total: number }>()
const { formatNumber } = useFormatters()

const ticking = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

watch(
  () => props.total,
  (value, previous) => {
    if (previous === undefined || value === previous) return
    ticking.value = true
    clearTimeout(timer)
    timer = setTimeout(() => {
      ticking.value = false
    }, 150)
  },
)

onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <p aria-live="polite" class="text-sm text-fg-2">
    <i18n-t keypath="catalog.results" tag="span">
      <template #count>
        <span
          class="font-numeric inline-block text-fg transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none"
          :class="ticking ? '-translate-y-0.5 opacity-70' : 'translate-y-0 opacity-100'"
          >{{ formatNumber(total) }}</span
        >
      </template>
    </i18n-t>
  </p>
</template>
