<script setup lang="ts">
import { DISCOUNT_STEPS } from '#shared/catalog'

/**
 * The "Знижка" section: one of three steps at a time, pressed again to clear.
 *
 * A value that is not one of the steps — `onSaleMinPercent=33` from a shared link, which the URL
 * layer accepts and the index answers — is shown as a fourth pressed chip rather than silently
 * left out: a filter that is counted and applied has to be visible and removable here too.
 */
const props = defineProps<{ onSaleMinPercent?: number }>()
const emit = defineEmits<{ change: [patch: { onSaleMinPercent?: number }] }>()
const { t } = useI18n()

const steps = computed<number[]>(() => {
  const known: number[] = [...DISCOUNT_STEPS]
  const current = props.onSaleMinPercent
  return current !== undefined && !known.includes(current) ? [...known, current] : known
})

function toggle(step: number) {
  emit('change', { onSaleMinPercent: props.onSaleMinPercent === step ? undefined : step })
}
</script>

<template>
  <div role="group" :aria-label="t('filters.discount')" class="flex flex-wrap gap-2">
    <button
      v-for="step in steps"
      :key="step"
      type="button"
      :aria-pressed="onSaleMinPercent === step"
      class="rounded-chip border px-3 py-1.5 text-sm focus-visible:outline-2"
      :class="
        onSaleMinPercent === step
          ? 'border-accent bg-accent text-on-accent'
          : 'border-line bg-surface-1 text-fg-2 hover:text-fg'
      "
      @click="toggle(step)"
    >
      <i18n-t keypath="filters.discountFrom" tag="span">
        <template #value
          ><span class="font-numeric">{{ step }}</span></template
        >
      </i18n-t>
    </button>
  </div>
</template>
