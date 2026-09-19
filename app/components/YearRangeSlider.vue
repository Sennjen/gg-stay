<script setup lang="ts">
/**
 * Dual year slider (two native range inputs over one track) plus from/to
 * number inputs. Emits the same patch shape as the old `filters/YearRange`.
 * `minYear`/`maxYear` are passed in so render stays deterministic (the page
 * derives `maxYear` from a server-provided date via `useState`, never
 * `Date.now()` in render). Handles cannot cross; the value only commits on
 * `change`, so a single drag produces one `useGameFilters` patch.
 */
const props = defineProps<{
  yearFrom?: number
  yearTo?: number
  upcoming?: boolean
  minYear: number
  maxYear: number
}>()
const emit = defineEmits<{
  change: [patch: { yearFrom?: number; yearTo?: number; upcoming?: boolean }]
}>()
const { t } = useI18n()

const fromValue = ref(props.yearFrom ?? props.minYear)
const toValue = ref(props.yearTo ?? props.maxYear)

watch(
  () => props.yearFrom,
  (value) => {
    fromValue.value = value ?? props.minYear
  },
)
watch(
  () => props.yearTo,
  (value) => {
    toValue.value = value ?? props.maxYear
  },
)

function clampFrom(value: number): number {
  if (!Number.isFinite(value)) return fromValue.value
  return Math.min(Math.max(value, props.minYear), toValue.value)
}
function clampTo(value: number): number {
  if (!Number.isFinite(value)) return toValue.value
  return Math.max(Math.min(value, props.maxYear), fromValue.value)
}

function onFromRangeInput(event: Event) {
  fromValue.value = clampFrom(Number((event.target as HTMLInputElement).value))
}
function onToRangeInput(event: Event) {
  toValue.value = clampTo(Number((event.target as HTMLInputElement).value))
}

/** Values sitting at the slider's own bounds are canonical "unset", so the URL stays as before. */
function commit() {
  emit('change', {
    yearFrom: fromValue.value <= props.minYear ? undefined : fromValue.value,
    yearTo: toValue.value >= props.maxYear ? undefined : toValue.value,
  })
}

function onFromNumberChange(event: Event) {
  const raw = Number((event.target as HTMLInputElement).value)
  if (!Number.isInteger(raw)) return
  fromValue.value = clampFrom(raw)
  commit()
}
function onToNumberChange(event: Event) {
  const raw = Number((event.target as HTMLInputElement).value)
  if (!Number.isInteger(raw)) return
  toValue.value = clampTo(raw)
  commit()
}
function onUpcomingChange(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  emit('change', { upcoming: checked || undefined, yearFrom: undefined, yearTo: undefined })
}

const span = computed(() => Math.max(props.maxYear - props.minYear, 1))
const fromPercent = computed(() => ((fromValue.value - props.minYear) / span.value) * 100)
const toPercent = computed(() => ((toValue.value - props.minYear) / span.value) * 100)
</script>

<template>
  <div>
    <div class="relative h-6" :class="{ 'opacity-50': upcoming }">
      <div class="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-surface-2" />
      <div
        class="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent"
        :style="{ left: fromPercent + '%', right: 100 - toPercent + '%' }"
      />
      <input
        type="range"
        class="range-thumb absolute inset-x-0 top-1/2 w-full -translate-y-1/2 appearance-none bg-transparent"
        :min="minYear"
        :max="maxYear"
        :value="fromValue"
        :disabled="upcoming"
        :aria-label="t('filters.yearFrom')"
        @input="onFromRangeInput"
        @change="commit"
      />
      <input
        type="range"
        class="range-thumb absolute inset-x-0 top-1/2 w-full -translate-y-1/2 appearance-none bg-transparent"
        :min="minYear"
        :max="maxYear"
        :value="toValue"
        :disabled="upcoming"
        :aria-label="t('filters.yearTo')"
        @input="onToRangeInput"
        @change="commit"
      />
    </div>

    <div class="mt-3 flex gap-2">
      <label class="flex-1 text-sm text-fg-2">
        {{ t('filters.yearFrom') }}
        <input
          type="number"
          inputmode="numeric"
          :min="minYear"
          :max="maxYear"
          :value="fromValue"
          :disabled="upcoming"
          class="font-numeric mt-1 w-full rounded-card border border-line bg-surface-1 px-2 py-1 text-fg focus-visible:outline-2"
          @change="onFromNumberChange"
        />
      </label>
      <label class="flex-1 text-sm text-fg-2">
        {{ t('filters.yearTo') }}
        <input
          type="number"
          inputmode="numeric"
          :min="minYear"
          :max="maxYear"
          :value="toValue"
          :disabled="upcoming"
          class="font-numeric mt-1 w-full rounded-card border border-line bg-surface-1 px-2 py-1 text-fg focus-visible:outline-2"
          @change="onToNumberChange"
        />
      </label>
    </div>

    <label class="mt-3 flex items-center gap-2 text-sm text-fg-2">
      <input
        type="checkbox"
        class="size-4 accent-accent focus-visible:outline-2"
        :checked="upcoming"
        @change="onUpcomingChange"
      />
      {{ t('filters.upcoming') }}
    </label>
  </div>
</template>

<style scoped>
.range-thumb {
  pointer-events: none;
}
.range-thumb::-webkit-slider-thumb {
  pointer-events: auto;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: var(--color-accent);
  cursor: pointer;
}
.range-thumb::-moz-range-thumb {
  pointer-events: auto;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: var(--color-accent);
  border: none;
  cursor: pointer;
}
.range-thumb::-webkit-slider-runnable-track {
  background: transparent;
}
.range-thumb::-moz-range-track {
  background: transparent;
}
</style>
