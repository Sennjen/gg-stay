<script setup lang="ts">
import {
  PLATFORM_OPTIONS,
  STORE_OPTIONS,
  USER_RATING_MIN,
  type AgeRatingValue,
  type GameModeValue,
} from '#shared/catalog'
import type { CatalogFilter } from '~/utils/filterUrl'

const props = defineProps<{ filter: CatalogFilter; genres: { slug: string; name: string }[] }>()
const emit = defineEmits<{ change: [patch: Partial<CatalogFilter>]; clear: [] }>()
const { t } = useI18n()

interface Chip {
  key: string
  /** Plain-text label: used for the remove button's `aria-label`, and rendered as-is
   * unless `yearPart` is set. */
  label: string
  /** Numbers displayed with no surrounding words get the mono numeral treatment. */
  numeric?: boolean
  /** One-sided year chip ("від 2010" / "from 2010"): only the year is a bare number, so it
   * renders through `<i18n-t>` with a slot, keeping the surrounding word out of the mono face. */
  yearPart?: { keypath: string; year: number }
  remove: () => void
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
      label: t('chips.search', { term: filter.search }),
      remove: () => emit('change', { search: undefined }),
    })
  }

  for (const slug of filter.genres ?? []) {
    const name = props.genres.find((genre) => genre.slug === slug)?.name ?? slug
    list.push({
      key: `genre:${slug}`,
      label: name,
      remove: () => emit('change', { genres: without(filter.genres, slug) }),
    })
  }

  for (const id of filter.platforms ?? []) {
    const name = PLATFORM_OPTIONS.find((option) => option.id === id)?.name ?? String(id)
    list.push({
      key: `platform:${id}`,
      label: name,
      remove: () => emit('change', { platforms: without(filter.platforms, id) }),
    })
  }

  if (filter.upcoming) {
    list.push({
      key: 'upcoming',
      label: t('filters.upcoming'),
      remove: () => emit('change', { upcoming: undefined }),
    })
  } else if (filter.yearFrom !== undefined && filter.yearTo !== undefined) {
    list.push({
      key: 'year',
      label: `${filter.yearFrom}–${filter.yearTo}`,
      numeric: true,
      remove: () => emit('change', { yearFrom: undefined, yearTo: undefined }),
    })
  } else if (filter.yearFrom !== undefined) {
    list.push({
      key: 'year',
      label: t('chips.yearFrom', { year: filter.yearFrom }),
      yearPart: { keypath: 'chips.yearFrom', year: filter.yearFrom },
      remove: () => emit('change', { yearFrom: undefined, yearTo: undefined }),
    })
  } else if (filter.yearTo !== undefined) {
    list.push({
      key: 'year',
      label: t('chips.yearTo', { year: filter.yearTo }),
      yearPart: { keypath: 'chips.yearTo', year: filter.yearTo },
      remove: () => emit('change', { yearFrom: undefined, yearTo: undefined }),
    })
  }

  if (filter.metacriticMin !== undefined) {
    list.push({
      key: 'metacritic',
      label: t('filters.metacriticMin', { value: filter.metacriticMin }),
      numeric: true,
      remove: () => emit('change', { metacriticMin: undefined }),
    })
  }

  if (filter.ratingMin === USER_RATING_MIN) {
    list.push({
      key: 'rating',
      label: t('filters.userRating'),
      remove: () => emit('change', { ratingMin: undefined }),
    })
  }

  if (filter.playtime) {
    list.push({
      key: 'playtime',
      label: t(`playtimes.${filter.playtime}`),
      remove: () => emit('change', { playtime: undefined }),
    })
  }

  for (const mode of filter.gameModes ?? []) {
    list.push({
      key: `mode:${mode}`,
      label: t(`gameModes.${mode}` as `gameModes.${GameModeValue}`),
      remove: () => emit('change', { gameModes: without(filter.gameModes, mode) }),
    })
  }

  for (const rating of filter.ageRating ?? []) {
    list.push({
      key: `age:${rating}`,
      label: t(`ageRatings.${rating}` as `ageRatings.${AgeRatingValue}`),
      remove: () => emit('change', { ageRating: without(filter.ageRating, rating) }),
    })
  }

  for (const slug of filter.stores ?? []) {
    const name = STORE_OPTIONS.find((store) => store.slug === slug)?.name ?? slug
    list.push({
      key: `store:${slug}`,
      label: name,
      remove: () => emit('change', { stores: without(filter.stores, slug) }),
    })
  }

  for (const slug of filter.developers ?? []) {
    list.push({
      key: `developer:${slug}`,
      label: slug,
      remove: () => emit('change', { developers: without(filter.developers, slug) }),
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
      class="inline-flex items-center gap-1 rounded-chip border border-line bg-surface-1 py-1 pl-3 pr-1.5 text-sm text-fg"
    >
      <i18n-t v-if="chip.yearPart" :keypath="chip.yearPart.keypath" tag="span">
        <template #year
          ><span class="font-numeric">{{ chip.yearPart.year }}</span></template
        >
      </i18n-t>
      <span v-else :class="{ 'font-numeric': chip.numeric }">{{ chip.label }}</span>
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
