<script setup lang="ts">
import { CatalogTaxonomiesDocument, GamesDocument } from '~/graphql/__generated__/operations'
import { DEFAULT_PAGE_SIZE } from '#shared/catalog'

const { t } = useI18n()
const { formatNumber } = useFormatters()
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

useSeoMeta({ title: () => t('catalog.title'), description: () => t('catalog.description') })
</script>

<template>
  <main>
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-bold">{{ t('catalog.title') }}</h1>
      <SortSelect :model-value="state.sort" @update:model-value="setSort" />
    </div>

    <div class="mt-6 grid gap-8 lg:grid-cols-[16rem_1fr]">
      <aside>
        <button
          type="button"
          class="mb-3 w-full rounded border border-slate-300 px-3 py-2 text-sm lg:hidden focus-visible:outline-2"
          :aria-expanded="store.panelOpen"
          aria-controls="filter-panel"
          @click="store.panelOpen = !store.panelOpen"
        >
          {{ t('catalog.filters') }}<span v-if="activeCount"> ({{ activeCount }})</span>
        </button>
        <div id="filter-panel" :class="store.panelOpen ? 'block' : 'hidden lg:block'">
          <FilterPanel :filter="state.filter" :genres="genres" @change="setFilter" />
        </div>
      </aside>

      <section aria-live="polite">
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
          <p class="mb-4 text-sm text-slate-600">
            {{ t('catalog.results', { count: formatNumber(page.total) }) }}
          </p>
          <GameGrid
            :games="page.items"
            :class="{ 'opacity-60': games.status.value === 'pending' }"
          />
          <Pagination :page="page.page" :has-next="page.hasNext" @change="setPage" />
        </template>
      </section>
    </div>
  </main>
</template>
