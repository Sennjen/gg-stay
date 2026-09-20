<script setup lang="ts">
import {
  PLATFORM_OPTIONS,
  STORE_OPTIONS,
  USER_RATING_MIN,
  type AgeRatingValue,
  type GameModeValue,
} from '#shared/catalog'
import type { CatalogFilter } from '~/utils/filterUrl'

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

interface Chip {
  key: string
  /** The schema field this chip stands for, so `ignoredFilters` can be matched against it. */
  field: keyof CatalogFilter
  /** Plain-text label: used for the remove button's `aria-label`, and rendered as-is
   * unless `yearPart` or `numberPart` is set. */
  label: string
  /** Numbers displayed with no surrounding words get the mono numeral treatment. */
  numeric?: boolean
  /** One-sided year chip ("від 2010" / "from 2010"): only the year is a bare number, so it
   * renders through `<i18n-t>` with a slot, keeping the surrounding word out of the mono face. */
  yearPart?: { keypath: string; year: number }
  /** The same treatment for any other string that interpolates one bare number or amount. */
  numberPart?: { keypath: string; slot: string; value: string | number }
  remove: () => void
}

/** Filters only RAWG can apply; when one of these is ignored, the index took the page instead. */
const RAWG_ONLY_FIELDS: readonly string[] = ['developers', 'publishers', 'tags']

function isIgnored(chip: Chip): boolean {
  return props.ignored?.includes(chip.field) ?? false
}

function reasonFor(chip: Chip): string {
  if (RAWG_ONLY_FIELDS.includes(chip.field)) return t('chips.ignoredWithPriceFilter')
  return props.indexStale ? t('chips.ignoredStalePrices') : t('chips.ignoredIndexDown')
}

function without<T>(values: T[] | undefined, value: T): T[] | undefined {
  const next = (values ?? []).filter((entry) => entry !== value)
  return next.length ? next : undefined
}

const chips = computed<Chip[]>(() => {
  const filter = props.filter
  const list: Chip[] = []

  if (filter.search) {
    list.push({
      key: 'search',
      field: 'search',
      label: t('chips.search', { term: filter.search }),
      remove: () => emit('change', { search: undefined }),
    })
  }

  for (const slug of filter.genres ?? []) {
    const name = props.genres.find((genre) => genre.slug === slug)?.name ?? slug
    list.push({
      key: `genre:${slug}`,
      field: 'genres',
      label: name,
      remove: () => emit('change', { genres: without(filter.genres, slug) }),
    })
  }

  for (const id of filter.platforms ?? []) {
    const name = PLATFORM_OPTIONS.find((option) => option.id === id)?.name ?? String(id)
    list.push({
      key: `platform:${id}`,
      field: 'platforms',
      label: name,
      remove: () => emit('change', { platforms: without(filter.platforms, id) }),
    })
  }

  if (filter.upcoming) {
    list.push({
      key: 'upcoming',
      field: 'upcoming',
      label: t('filters.upcoming'),
      remove: () => emit('change', { upcoming: undefined }),
    })
  } else if (filter.yearFrom !== undefined && filter.yearTo !== undefined) {
    list.push({
      key: 'year',
      field: 'yearFrom',
      label: `${filter.yearFrom}–${filter.yearTo}`,
      numeric: true,
      remove: () => emit('change', { yearFrom: undefined, yearTo: undefined }),
    })
  } else if (filter.yearFrom !== undefined) {
    list.push({
      key: 'year',
      field: 'yearFrom',
      label: t('chips.yearFrom', { year: filter.yearFrom }),
      yearPart: { keypath: 'chips.yearFrom', year: filter.yearFrom },
      remove: () => emit('change', { yearFrom: undefined, yearTo: undefined }),
    })
  } else if (filter.yearTo !== undefined) {
    list.push({
      key: 'year',
      field: 'yearFrom',
      label: t('chips.yearTo', { year: filter.yearTo }),
      yearPart: { keypath: 'chips.yearTo', year: filter.yearTo },
      remove: () => emit('change', { yearFrom: undefined, yearTo: undefined }),
    })
  }

  if (filter.metacriticMin !== undefined) {
    list.push({
      key: 'metacritic',
      field: 'metacriticMin',
      label: t('filters.metacriticMin', { value: filter.metacriticMin }),
      numeric: true,
      remove: () => emit('change', { metacriticMin: undefined }),
    })
  }

  if (filter.ratingMin === USER_RATING_MIN) {
    list.push({
      key: 'rating',
      field: 'ratingMin',
      label: t('filters.userRating'),
      remove: () => emit('change', { ratingMin: undefined }),
    })
  }

  if (filter.playtime) {
    list.push({
      key: 'playtime',
      field: 'playtime',
      label: t(`playtimes.${filter.playtime}`),
      remove: () => emit('change', { playtime: undefined }),
    })
  }

  for (const mode of filter.gameModes ?? []) {
    list.push({
      key: `mode:${mode}`,
      field: 'gameModes',
      label: t(`gameModes.${mode}` as `gameModes.${GameModeValue}`),
      remove: () => emit('change', { gameModes: without(filter.gameModes, mode) }),
    })
  }

  for (const rating of filter.ageRating ?? []) {
    list.push({
      key: `age:${rating}`,
      field: 'ageRating',
      label: t(`ageRatings.${rating}` as `ageRatings.${AgeRatingValue}`),
      remove: () => emit('change', { ageRating: without(filter.ageRating, rating) }),
    })
  }

  for (const slug of filter.stores ?? []) {
    const name = STORE_OPTIONS.find((store) => store.slug === slug)?.name ?? slug
    list.push({
      key: `store:${slug}`,
      field: 'stores',
      label: name,
      remove: () => emit('change', { stores: without(filter.stores, slug) }),
    })
  }

  for (const slug of filter.developers ?? []) {
    list.push({
      key: `developer:${slug}`,
      field: 'developers',
      label: slug,
      remove: () => emit('change', { developers: without(filter.developers, slug) }),
    })
  }

  if (filter.free) {
    list.push({
      key: 'free',
      field: 'free',
      label: t('price.free'),
      remove: () => emit('change', { free: undefined }),
    })
  }

  if (filter.priceMaxUah !== undefined) {
    const price = formatUah(filter.priceMaxUah)
    list.push({
      key: 'priceMaxUah',
      field: 'priceMaxUah',
      label: t('filters.priceUpTo', { price }),
      numberPart: { keypath: 'filters.priceUpTo', slot: 'price', value: price },
      remove: () => emit('change', { priceMaxUah: undefined }),
    })
  }

  if (filter.onSaleMinPercent !== undefined) {
    list.push({
      key: 'onSaleMinPercent',
      field: 'onSaleMinPercent',
      label: t('filters.discountFrom', { value: filter.onSaleMinPercent }),
      numberPart: {
        keypath: 'filters.discountFrom',
        slot: 'value',
        value: filter.onSaleMinPercent,
      },
      remove: () => emit('change', { onSaleMinPercent: undefined }),
    })
  }

  if (filter.ukrainianLocalisation) {
    list.push({
      key: 'ukrainianLocalisation',
      field: 'ukrainianLocalisation',
      label: t(`chips.localisation${filter.ukrainianLocalisation}`),
      remove: () => emit('change', { ukrainianLocalisation: undefined }),
    })
  }

  return list
})
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
