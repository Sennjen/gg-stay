<script setup lang="ts">
import {
  AGE_RATINGS,
  GAME_MODES,
  METACRITIC_STEPS,
  PLATFORM_OPTIONS,
  PLAYTIMES,
  STORE_OPTIONS,
  USER_RATING_MIN,
} from '#shared/catalog'
import type { CatalogFilter } from '~/utils/filterUrl'

const props = defineProps<{ filter: CatalogFilter; genres: { slug: string; name: string }[] }>()
const emit = defineEmits<{ change: [patch: Partial<CatalogFilter>] }>()
const { t } = useI18n()

const search = ref(props.filter.search ?? '')
watch(
  () => props.filter.search,
  (value) => (search.value = value ?? ''),
)

const platformOptions = PLATFORM_OPTIONS.map((option) => ({ value: option.id, label: option.name }))
const storeOptions = STORE_OPTIONS.map((option) => ({ value: option.slug, label: option.name }))
const genreOptions = computed(() =>
  props.genres.map((genre) => ({ value: genre.slug, label: genre.name })),
)
const modeOptions = computed(() =>
  GAME_MODES.map((mode) => ({ value: mode, label: t(`gameModes.${mode}`) })),
)
const ageOptions = computed(() =>
  AGE_RATINGS.map((rating) => ({ value: rating, label: t(`ageRatings.${rating}`) })),
)
const playtimeOptions = computed(() =>
  PLAYTIMES.map((value) => ({ value, label: t(`playtimes.${value}`) })),
)
const metacriticOptions = computed(() =>
  METACRITIC_STEPS.map((value) => ({ value, label: t('filters.metacriticMin', { value }) })),
)

/** Empty arrays become undefined so the URL stays canonical. */
function orUndefined<T>(values: T[]): T[] | undefined {
  return values.length ? values : undefined
}

function onPlatformsChange(value: number[]) {
  emit('change', { platforms: orUndefined(value) })
}
function onGenresChange(value: string[]) {
  emit('change', { genres: orUndefined(value) })
}
function onGameModesChange(value: (typeof GAME_MODES)[number][]) {
  emit('change', { gameModes: orUndefined(value) })
}
function onAgeRatingChange(value: (typeof AGE_RATINGS)[number][]) {
  emit('change', { ageRating: orUndefined(value) })
}
function onStoresChange(value: string[]) {
  emit('change', { stores: orUndefined(value) })
}
function onDevelopersChange(value: string[]) {
  emit('change', { developers: orUndefined(value) })
}
function onMetacriticChange(value: number | undefined) {
  emit('change', { metacriticMin: value })
}
function onPlaytimeChange(value: (typeof PLAYTIMES)[number] | undefined) {
  emit('change', { playtime: value })
}
</script>

<template>
  <form
    :aria-label="t('catalog.filters')"
    @submit.prevent="emit('change', { search: search.trim() || undefined })"
  >
    <div class="flex gap-2 pb-4">
      <input
        v-model="search"
        type="search"
        :aria-label="t('catalog.search')"
        :placeholder="t('catalog.search')"
        class="min-w-0 flex-1 rounded border border-slate-300 px-3 py-2 text-sm focus-visible:outline-2"
      />
      <button
        type="submit"
        class="rounded bg-slate-900 px-3 py-2 text-sm text-white focus-visible:outline-2"
      >
        {{ t('catalog.searchButton') }}
      </button>
    </div>

    <FiltersCheckboxList
      :legend="t('filters.platform')"
      :options="platformOptions"
      :model-value="filter.platforms ?? []"
      @update:model-value="onPlatformsChange"
    />
    <FiltersCheckboxList
      :legend="t('filters.genre')"
      :options="genreOptions"
      :model-value="filter.genres ?? []"
      @update:model-value="onGenresChange"
    />
    <FiltersYearRange
      :year-from="filter.yearFrom"
      :year-to="filter.yearTo"
      :upcoming="filter.upcoming"
      @change="emit('change', $event)"
    />
    <FiltersRadioList
      name="metacritic"
      :legend="t('filters.metacritic')"
      :options="metacriticOptions"
      :model-value="filter.metacriticMin"
      @update:model-value="onMetacriticChange"
    />
    <FiltersFilterGroup :legend="t('filters.userRating')">
      <label class="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          class="size-4 focus-visible:outline-2"
          :checked="filter.ratingMin === USER_RATING_MIN"
          @change="
            emit('change', {
              ratingMin: ($event.target as HTMLInputElement).checked ? USER_RATING_MIN : undefined,
            })
          "
        />
        {{ t('filters.userRating') }}
      </label>
    </FiltersFilterGroup>
    <FiltersRadioList
      name="playtime"
      :legend="t('filters.playtime')"
      :options="playtimeOptions"
      :model-value="filter.playtime"
      @update:model-value="onPlaytimeChange"
    />
    <FiltersCheckboxList
      :legend="t('filters.gameMode')"
      :options="modeOptions"
      :model-value="filter.gameModes ?? []"
      @update:model-value="onGameModesChange"
    />
    <FiltersCheckboxList
      :legend="t('filters.ageRating')"
      :options="ageOptions"
      :model-value="filter.ageRating ?? []"
      @update:model-value="onAgeRatingChange"
    />
    <FiltersCheckboxList
      :legend="t('filters.store')"
      :options="storeOptions"
      :model-value="filter.stores ?? []"
      @update:model-value="onStoresChange"
    />
    <FiltersDeveloperAutocomplete
      :model-value="filter.developers ?? []"
      @update:model-value="onDevelopersChange"
    />
  </form>
</template>
