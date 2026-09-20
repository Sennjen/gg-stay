<script setup lang="ts">
import { NON_INDEX_SORTS, UI_SORTS, type GameSortValue } from '#shared/catalog'
import { DEFAULT_SORT } from '~/utils/filterUrl'

const props = defineProps<{
  modelValue: GameSortValue
  /** Prices are too old to trust, so the three sorts built on them are not offered. */
  indexStale?: boolean
  /** The answer reports `sort` among the filters it could not apply. */
  ignored?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: GameSortValue] }>()
const { t } = useI18n()

const options = computed<readonly GameSortValue[]>(() =>
  props.indexStale ? NON_INDEX_SORTS : UI_SORTS,
)

/**
 * A sort the server dropped is not what the list is in, and showing it selected would be a small
 * lie the visitor has no way to check. The control falls back to the order the page is actually
 * in, and the note beside it names the sort that did not happen.
 */
const shown = computed<GameSortValue>(() =>
  options.value.includes(props.modelValue) ? props.modelValue : DEFAULT_SORT,
)
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
    <label class="flex items-center gap-2 text-sm text-fg-2">
      <span class="hidden sm:inline">{{ t('catalog.sort') }}</span>
      <select
        :value="shown"
        :aria-label="t('catalog.sort')"
        class="rounded-chip border border-line bg-surface-1 px-3 py-1.5 text-sm text-fg focus-visible:outline-2"
        @change="
          emit('update:modelValue', ($event.target as HTMLSelectElement).value as GameSortValue)
        "
      >
        <option v-for="sort in options" :key="sort" :value="sort">{{ t(`sorts.${sort}`) }}</option>
      </select>
    </label>
    <p v-if="ignored" data-test="sort-ignored" class="text-xs text-fg-2">
      {{ t('catalog.sortIgnored', { name: t(`sorts.${modelValue}`) }) }}
    </p>
  </div>
</template>
