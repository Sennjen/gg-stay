<script setup lang="ts">
import { MAX_PRICE_UAH, PRICE_STEPS } from '#shared/catalog'

/**
 * The "Ціна" section: the free chip, three ready-made ceilings and a hand-typed amount.
 *
 * `free` and `priceMaxUah` are two different filters, and the drawer never sets both — choosing
 * one clears the other, so a visitor is never looking at "free games costing up to 300 ₴". The
 * URL layer still parses both, because a hand-written link carrying both is two real filters and
 * each has its own chip.
 */
const props = defineProps<{ priceMaxUah?: number; free?: boolean }>()
const emit = defineEmits<{ change: [patch: { priceMaxUah?: number; free?: boolean }] }>()
const { t } = useI18n()
const { formatUah } = useFormatters()

const inputId = useId()

const steps = computed(() =>
  PRICE_STEPS.map((value) => ({
    value,
    label: t('filters.priceUpTo', { price: formatUah(value) }),
  })),
)

function toggleFree() {
  emit('change', props.free ? { free: undefined } : { free: true, priceMaxUah: undefined })
}

function toggleStep(step: number) {
  emit(
    'change',
    props.priceMaxUah === step
      ? { priceMaxUah: undefined }
      : { priceMaxUah: step, free: undefined },
  )
}

/**
 * The field always shows the ceiling that is actually in force, wherever it came from — a chip, a
 * shared link or this input — so the section never contradicts the URL.
 */
// `v-model` on a number input hands back a number, or an empty string when the field is blank or
// holds something the browser cannot read as a number, so this ref carries both.
const own = ref<string | number>(props.priceMaxUah ?? '')
let timer: ReturnType<typeof setTimeout> | undefined

watch(
  () => props.priceMaxUah,
  (value) => {
    const next = value ?? ''
    if (String(next) === String(own.value)) return
    // A value arriving from the URL is not typing: cancel the pending emit rather than send the
    // filter back to where it already is.
    clearTimeout(timer)
    own.value = next
  },
)

watch(own, (value) => {
  clearTimeout(timer)
  const trimmed = String(value).trim()
  if (trimmed !== '' && !/^\d+$/.test(trimmed)) return
  const parsed = trimmed === '' ? undefined : Number(trimmed)
  if (parsed !== undefined && (parsed < 1 || parsed > MAX_PRICE_UAH)) return
  if (parsed === props.priceMaxUah) return
  timer = setTimeout(() => {
    emit(
      'change',
      parsed === undefined ? { priceMaxUah: undefined } : { priceMaxUah: parsed, free: undefined },
    )
  }, OWN_AMOUNT_DEBOUNCE_MS)
})

onBeforeUnmount(() => clearTimeout(timer))
</script>

<script lang="ts">
/**
 * How long the hand-typed amount waits after the last keystroke. Every change pushes a route and
 * re-queries the catalog, so typing "1000" must cost one navigation rather than four.
 */
export const OWN_AMOUNT_DEBOUNCE_MS = 400
</script>

<template>
  <div class="space-y-3">
    <div role="group" :aria-label="t('filters.price')" class="flex flex-wrap gap-2">
      <button
        type="button"
        :aria-pressed="free === true"
        class="rounded-chip border px-3 py-1.5 text-sm focus-visible:outline-2"
        :class="
          free
            ? 'border-accent bg-accent text-on-accent'
            : 'border-line bg-surface-1 text-fg-2 hover:text-fg'
        "
        @click="toggleFree"
      >
        {{ t('price.free') }}
      </button>
      <button
        v-for="step in steps"
        :key="step.value"
        type="button"
        :aria-pressed="priceMaxUah === step.value"
        class="rounded-chip border px-3 py-1.5 text-sm focus-visible:outline-2"
        :class="
          priceMaxUah === step.value
            ? 'border-accent bg-accent text-on-accent'
            : 'border-line bg-surface-1 text-fg-2 hover:text-fg'
        "
        @click="toggleStep(step.value)"
      >
        {{ step.label }}
      </button>
    </div>

    <div class="flex items-center gap-2">
      <label :for="inputId" class="shrink-0 text-sm text-fg-2">{{ t('filters.priceOwn') }}</label>
      <input
        :id="inputId"
        v-model="own"
        type="number"
        inputmode="numeric"
        step="1"
        autocomplete="off"
        min="1"
        :max="MAX_PRICE_UAH"
        :placeholder="t('filters.priceOwnPlaceholder')"
        class="font-numeric w-28 rounded-card border border-line bg-surface-1 px-2 py-1 text-sm text-fg focus-visible:outline-2"
      />
    </div>
  </div>
</template>
