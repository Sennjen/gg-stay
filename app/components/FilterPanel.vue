<script setup lang="ts">
import {
  AGE_RATINGS,
  GAME_MODES,
  LOCALISATIONS,
  METACRITIC_STEPS,
  PLATFORM_OPTIONS,
  PLAYTIMES,
  STORE_OPTIONS,
  USER_RATING_MIN,
  type LocalisationValue,
} from '#shared/catalog'
import type { CatalogFilter } from '~/utils/filterUrl'

const props = defineProps<{
  filter: CatalogFilter
  genres: { slug: string; name: string }[]
  /** Deterministic upper bound for the year slider (current year + 2), passed by the page. */
  maxYear: number
  /**
   * The index's prices are too old to be trusted. Price and discount are withheld — the server
   * would drop them anyway — while Ukrainian localisation, which does not depend on the price
   * stage, keeps working.
   */
  indexStale?: boolean
}>()
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
const localisationOptions = computed(() =>
  LOCALISATIONS.map((value) => ({ value, label: t(`filters.localisation${labelOf(value)}`) })),
)

/** `ANY` → `Any`, `TEXT` → `Text`, `AUDIO` → `Audio`: the locale keys are camel-cased. */
function labelOf(value: LocalisationValue): 'Any' | 'Text' | 'Audio' {
  return value === 'ANY' ? 'Any' : value === 'TEXT' ? 'Text' : 'Audio'
}

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
function toggleRating() {
  emit('change', {
    ratingMin: props.filter.ratingMin === USER_RATING_MIN ? undefined : USER_RATING_MIN,
  })
}

/** Sections that hold an active value start open; toggling one afterwards is remembered in the store. */
const sectionActive = computed(() => ({
  platform: (props.filter.platforms?.length ?? 0) > 0,
  genre: (props.filter.genres?.length ?? 0) > 0,
  year:
    props.filter.yearFrom !== undefined ||
    props.filter.yearTo !== undefined ||
    props.filter.upcoming === true,
  metacritic: props.filter.metacriticMin !== undefined,
  userRating: props.filter.ratingMin !== undefined,
  playtime: props.filter.playtime !== undefined,
  gameMode: (props.filter.gameModes?.length ?? 0) > 0,
  ageRating: (props.filter.ageRating?.length ?? 0) > 0,
  store: (props.filter.stores?.length ?? 0) > 0,
  developer: (props.filter.developers?.length ?? 0) > 0,
  price: props.filter.priceMaxUah !== undefined || props.filter.free === true,
  discount: props.filter.onSaleMinPercent !== undefined,
  localisation: props.filter.ukrainianLocalisation !== undefined,
}))
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
        class="min-w-0 flex-1 rounded-card border border-line bg-surface-1 px-3 py-2 text-sm text-fg focus-visible:outline-2"
      />
      <button
        type="submit"
        class="rounded-chip bg-accent px-3 py-2 text-sm text-on-accent focus-visible:outline-2"
      >
        {{ t('catalog.searchButton') }}
      </button>
    </div>

    <FilterSection
      v-if="!indexStale"
      section-id="price"
      :title="t('filters.price')"
      :active="sectionActive.price"
    >
      <FiltersPriceFilter
        :price-max-uah="filter.priceMaxUah"
        :free="filter.free"
        @change="emit('change', $event)"
      />
    </FilterSection>

    <FilterSection
      v-if="!indexStale"
      section-id="discount"
      :title="t('filters.discount')"
      :active="sectionActive.discount"
    >
      <FiltersDiscountFilter
        :on-sale-min-percent="filter.onSaleMinPercent"
        @change="emit('change', $event)"
      />
    </FilterSection>

    <FilterSection
      section-id="localisation"
      :title="t('filters.localisation')"
      :active="sectionActive.localisation"
    >
      <SegmentedControl
        :legend="t('filters.localisation')"
        :any-label="t('filters.localisationNotImportant')"
        :options="localisationOptions"
        :model-value="filter.ukrainianLocalisation"
        @update:model-value="emit('change', { ukrainianLocalisation: $event })"
      />
    </FilterSection>

    <FilterSection
      section-id="platform"
      :title="t('filters.platform')"
      :active="sectionActive.platform"
    >
      <FiltersCheckboxList
        :legend="t('filters.platform')"
        :options="platformOptions"
        :model-value="filter.platforms ?? []"
        @update:model-value="onPlatformsChange"
      />
    </FilterSection>

    <FilterSection section-id="genre" :title="t('filters.genre')" :active="sectionActive.genre">
      <FiltersCheckboxList
        :legend="t('filters.genre')"
        :options="genreOptions"
        :model-value="filter.genres ?? []"
        @update:model-value="onGenresChange"
      />
    </FilterSection>

    <FilterSection section-id="year" :title="t('filters.year')" :active="sectionActive.year">
      <YearRangeSlider
        :year-from="filter.yearFrom"
        :year-to="filter.yearTo"
        :upcoming="filter.upcoming"
        :min-year="1970"
        :max-year="maxYear"
        @change="emit('change', $event)"
      />
    </FilterSection>

    <FilterSection
      section-id="metacritic"
      :title="t('filters.metacritic')"
      :active="sectionActive.metacritic"
    >
      <SegmentedControl
        :legend="t('filters.metacritic')"
        :any-label="t('catalog.any')"
        :options="metacriticOptions"
        :model-value="filter.metacriticMin"
        @update:model-value="onMetacriticChange"
      />
    </FilterSection>

    <FilterSection
      section-id="userRating"
      :title="t('filters.userRating')"
      :active="sectionActive.userRating"
    >
      <button
        type="button"
        :aria-pressed="filter.ratingMin === USER_RATING_MIN"
        class="rounded-chip border px-3 py-1.5 text-sm focus-visible:outline-2"
        :class="
          filter.ratingMin === USER_RATING_MIN
            ? 'border-accent bg-accent text-on-accent'
            : 'border-line bg-surface-1 text-fg-2 hover:text-fg'
        "
        @click="toggleRating"
      >
        {{ t('filters.userRating') }}
      </button>
    </FilterSection>

    <FilterSection
      section-id="playtime"
      :title="t('filters.playtime')"
      :active="sectionActive.playtime"
    >
      <SegmentedControl
        :legend="t('filters.playtime')"
        :any-label="t('catalog.any')"
        :options="playtimeOptions"
        :model-value="filter.playtime"
        @update:model-value="onPlaytimeChange"
      />
    </FilterSection>

    <FilterSection
      section-id="gameMode"
      :title="t('filters.gameMode')"
      :active="sectionActive.gameMode"
    >
      <FiltersCheckboxList
        :legend="t('filters.gameMode')"
        :options="modeOptions"
        :model-value="filter.gameModes ?? []"
        @update:model-value="onGameModesChange"
      />
    </FilterSection>

    <FilterSection
      section-id="ageRating"
      :title="t('filters.ageRating')"
      :active="sectionActive.ageRating"
    >
      <FiltersCheckboxList
        :legend="t('filters.ageRating')"
        :options="ageOptions"
        :model-value="filter.ageRating ?? []"
        @update:model-value="onAgeRatingChange"
      />
    </FilterSection>

    <FilterSection section-id="store" :title="t('filters.store')" :active="sectionActive.store">
      <FiltersCheckboxList
        :legend="t('filters.store')"
        :options="storeOptions"
        :model-value="filter.stores ?? []"
        @update:model-value="onStoresChange"
      />
    </FilterSection>

    <FilterSection
      section-id="developer"
      :title="t('filters.developer')"
      :active="sectionActive.developer"
    >
      <FiltersDeveloperAutocomplete
        :model-value="filter.developers ?? []"
        @update:model-value="onDevelopersChange"
      />
    </FilterSection>
  </form>
</template>
