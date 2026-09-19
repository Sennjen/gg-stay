<script setup lang="ts">
const props = defineProps<{ yearFrom?: number; yearTo?: number; upcoming?: boolean }>()
const emit = defineEmits<{
  change: [patch: { yearFrom?: number; yearTo?: number; upcoming?: boolean }]
}>()
const { t } = useI18n()

function parseYear(raw: string): number | undefined {
  const year = Number(raw)
  return Number.isInteger(year) && year >= 1970 && year <= 2100 ? year : undefined
}
</script>

<template>
  <FiltersFilterGroup :legend="t('filters.year')">
    <div class="flex gap-2">
      <label class="flex-1 text-sm">
        {{ t('filters.yearFrom') }}
        <input
          type="number"
          min="1970"
          max="2100"
          inputmode="numeric"
          :value="props.yearFrom ?? ''"
          :disabled="props.upcoming"
          class="mt-1 w-full rounded-lg border border-line bg-surface-1 px-2 py-1 text-fg focus-visible:outline-2"
          @change="
            emit('change', { yearFrom: parseYear(($event.target as HTMLInputElement).value) })
          "
        />
      </label>
      <label class="flex-1 text-sm">
        {{ t('filters.yearTo') }}
        <input
          type="number"
          min="1970"
          max="2100"
          inputmode="numeric"
          :value="props.yearTo ?? ''"
          :disabled="props.upcoming"
          class="mt-1 w-full rounded-lg border border-line bg-surface-1 px-2 py-1 text-fg focus-visible:outline-2"
          @change="emit('change', { yearTo: parseYear(($event.target as HTMLInputElement).value) })"
        />
      </label>
    </div>
    <label class="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        :checked="props.upcoming"
        class="size-4 accent-accent focus-visible:outline-2"
        @change="
          emit('change', {
            upcoming: ($event.target as HTMLInputElement).checked || undefined,
            yearFrom: undefined,
            yearTo: undefined,
          })
        "
      />
      {{ t('filters.upcoming') }}
    </label>
  </FiltersFilterGroup>
</template>
