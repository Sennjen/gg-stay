<script setup lang="ts">
import { CatalogTaxonomiesDocument, GamesDocument } from '~/graphql/__generated__/operations'
import { DEFAULT_PAGE_SIZE, MAX_PAGE } from '#shared/catalog'

const { t } = useI18n()
const { state, activeCount, setFilter, setSort, setPage, clear } = useGameFilters()
const store = useFiltersStore()

const variables = computed(() => ({
  filter: state.value.filter,
  sort: state.value.sort,
  page: state.value.page,
  pageSize: DEFAULT_PAGE_SIZE,
}))

const [games, taxonomies] = await Promise.all([
  useGql(GamesDocument, variables),
  useGql(CatalogTaxonomiesDocument, {}),
])
const page = computed(() => games.data.value?.games ?? null)
const genres = computed(() => taxonomies.data.value?.genres ?? [])
const totalPages = computed(() =>
  page.value
    ? Math.min(Math.max(Math.ceil(page.value.total / page.value.pageSize), 1), MAX_PAGE)
    : 1,
)

// Deterministic upper bound for the year slider: computed once (server or first client render)
// and reused from then on, so no component ever calls `Date.now()` during render.
const currentYear = useState('catalog-current-year', () => new Date().getFullYear())
const maxSliderYear = computed(() => currentYear.value + 2)

const filtersButtonEl = ref<HTMLButtonElement>()

useSeoMeta({ title: () => t('catalog.title'), description: () => t('catalog.description') })
</script>

<template>
  <main>
    <h1 class="font-display-heading text-2xl text-fg">{{ t('catalog.title') }}</h1>

    <div class="mt-4 flex flex-wrap items-center gap-3">
      <button
        ref="filtersButtonEl"
        type="button"
        class="rounded-chip border border-line bg-surface-1 px-4 py-2 text-sm text-fg focus-visible:outline-2"
        @click="store.panelOpen = true"
      >
        <i18n-t v-if="activeCount" keypath="drawer.openButton" tag="span">
          <template #count
            ><span class="font-numeric">{{ activeCount }}</span></template
          >
        </i18n-t>
        <template v-else>{{ t('catalog.filters') }}</template>
      </button>

      <ResultCount v-if="page" :total="page.total" />

      <div class="ml-auto flex items-center gap-3">
        <SortSelect :model-value="state.sort" @update:model-value="setSort" />
        <ViewToggle />
      </div>
    </div>

    <ActiveFilterChips
      v-if="activeCount"
      class="mt-3"
      :filter="state.filter"
      :genres="genres"
      @change="setFilter"
      @clear="clear"
    />

    <FilterDrawer :trigger-el="filtersButtonEl" :result-total="page?.total ?? 0" @reset="clear">
      <FilterPanel
        :filter="state.filter"
        :genres="genres"
        :max-year="maxSliderYear"
        @change="setFilter"
      />
    </FilterDrawer>

    <section class="mt-6" aria-live="polite">
      <StatesErrorState
        v-if="games.errorCode.value"
        :code="games.errorCode.value"
        @retry="games.refresh()"
      />
      <StatesLoadingState v-else-if="games.status.value === 'pending' && !page" />
      <StatesEmptyState
        v-else-if="page && page.items.length === 0"
        :active-count="activeCount"
        @clear="clear"
      />
      <template v-else-if="page">
        <GameGrid
          :games="page.items"
          :layout="store.viewMode"
          :class="{ 'opacity-60': games.status.value === 'pending' }"
        />
        <Pagination :page="page.page" :total-pages="totalPages" @change="setPage" />
      </template>
    </section>
  </main>
</template>
