<script setup lang="ts">
import { filterLabels } from '~/utils/filterLabels'
import type { CatalogFilter } from '~/utils/filterUrl'

/**
 * A filter described in the catalog's own chip words (`filterLabels`, the same vocabulary
 * `ActiveFilterChips` and the catalog's meta description read), for a page that shows a filter
 * without owning it — the ask page's "understood filter". The chips carry no remove button and no
 * reset: a control that looked like the catalog's but changed nothing would be one whose meaning a
 * visitor has to guess. Changing the filter is what the "open in the catalog" link next to it is
 * for.
 */
const props = defineProps<{
  filter: CatalogFilter
  genres: { slug: string; name: string }[]
  /** The caption shown before the chips, which also names the list, e.g. "Зрозумілий фільтр:". */
  label: string
}>()
const { t } = useI18n()
const { formatUah } = useFormatters()

const labelId = useId()

const chips = computed(() => filterLabels(props.filter, { t, formatUah, genres: props.genres }))
</script>

<template>
  <div v-if="chips.length" class="flex flex-wrap items-center gap-2">
    <span :id="labelId" class="text-sm text-fg-2">{{ label }}</span>
    <!-- Its own flex row rather than `display: contents`, which some browsers answer by dropping
         the list's role along with its box. -->
    <ul :aria-labelledby="labelId" class="flex flex-wrap items-center gap-2">
      <li
        v-for="chip in chips"
        :key="chip.key"
        class="inline-flex items-center rounded-chip border border-line bg-surface-1 px-3 py-1 text-sm whitespace-nowrap text-fg"
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
      </li>
    </ul>
  </div>
</template>
