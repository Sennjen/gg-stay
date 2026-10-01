<script setup lang="ts">
import { filterLabels, type FilterLabel } from '~/utils/filterLabels'
import { INDEX_FILTER_FIELDS, type CatalogFilter } from '~/utils/filterUrl'

const props = defineProps<{
  filter: CatalogFilter
  genres: { slug: string; name: string }[]
  /**
   * The schema field names the answer could not apply (`GamePage.ignoredFilters`). Their chips
   * are struck through and say why, in words — but stay, and stay removable: a filter the URL
   * still carries is one a visitor has to be able to take off.
   */
  ignored?: readonly string[]
  /** Which explanation an ignored index filter gets: stale prices, or an index that is silent. */
  indexStale?: boolean
}>()
const emit = defineEmits<{ change: [patch: Partial<CatalogFilter>]; clear: [] }>()
const { t } = useI18n()
const { formatUah } = useFormatters()

/** A label from `filterLabels`, with the click that removes it. */
interface Chip extends FilterLabel {
  remove: () => void
}

function isIgnored(chip: Chip): boolean {
  return props.ignored?.includes(chip.field) ?? false
}

/**
 * Why the answer could not apply this filter, in words a visitor can act on.
 *
 * The server does not say why — `ignoredFilters` is a bare list of field names — so the reason is
 * read off the only two things that produce one. An **index** filter is in the list because the
 * index could not serve it, and `indexStale` tells a stale price run from a silent store.
 * Anything else in the list is a filter only RAWG can apply, which lost the page to the index.
 * Deriving the first case from `INDEX_FILTER_FIELDS` rather than naming the second case's fields
 * here means a field added to the URL layer cannot quietly fall into the wrong explanation.
 */
function reasonFor(chip: Chip): string {
  if ((INDEX_FILTER_FIELDS as readonly string[]).includes(chip.field)) {
    return props.indexStale ? t('chips.ignoredStalePrices') : t('chips.ignoredIndexDown')
  }
  return t('chips.ignoredWithPriceFilter')
}

// The words come from `filterLabels`, which the catalog's meta description reads too, so a chip
// and the description of the same page never disagree.
const chips = computed<Chip[]>(() =>
  filterLabels(props.filter, { t, formatUah, genres: props.genres }).map((label) => ({
    ...label,
    remove: () => emit('change', label.patch),
  })),
)
</script>

<template>
  <div v-if="chips.length" class="flex flex-wrap items-center gap-2">
    <span
      v-for="chip in chips"
      :key="chip.key"
      :data-test="isIgnored(chip) ? 'ignored-chip' : undefined"
      class="inline-flex items-center gap-1 rounded-chip border border-line bg-surface-1 py-1 pl-3 pr-1.5 text-sm text-fg"
    >
      <!-- An ignored filter keeps its chip and its remove button: the URL still carries it, so it
           has to stay visible and removable. The strike-through is the glance, the sentence beside
           it is the explanation — it is real text, not a title, so it never depends on hover. -->
      <component
        :is="isIgnored(chip) ? 's' : 'span'"
        class="inline-flex shrink-0 items-center whitespace-nowrap"
      >
        <i18n-t v-if="chip.yearPart" :keypath="chip.yearPart.keypath" tag="span">
          <template #year
            ><span class="font-numeric">{{ chip.yearPart.year }}</span></template
          >
        </i18n-t>
        <i18n-t v-else-if="chip.numberPart" :keypath="chip.numberPart.keypath" tag="span">
          <template #[chip.numberPart.slot]
            ><span class="font-numeric">{{ chip.numberPart.value }}</span></template
          >
        </i18n-t>
        <span v-else :class="{ 'font-numeric': chip.numeric }">{{ chip.label }}</span>
      </component>
      <span v-if="isIgnored(chip)" class="text-xs text-fg-2">
        {{ t('chips.ignored', { reason: reasonFor(chip) }) }}
      </span>
      <button
        type="button"
        class="flex size-5 items-center justify-center rounded-full text-fg-2 hover:text-fg focus-visible:outline-2"
        :aria-label="t('filters.remove', { name: chip.label })"
        @click="chip.remove()"
      >
        ×
      </button>
    </span>
    <button
      type="button"
      class="rounded-chip border border-signal px-3 py-1.5 text-sm text-signal focus-visible:outline-2"
      @click="emit('clear')"
    >
      {{ t('chips.resetAll') }}
    </button>
  </div>
</template>
