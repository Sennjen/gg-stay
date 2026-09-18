import {
  countActiveFilters,
  parseFilterQuery,
  serializeFilterState,
  type CatalogFilter,
  type CatalogState,
} from '~/utils/filterUrl'
import type { GameSortValue } from '#shared/catalog'

/** Single owner of the catalog query string: every read and write goes through here. */
export function useGameFilters() {
  const route = useRoute()
  const router = useRouter()
  const store = useFiltersStore()

  const state = computed<CatalogState>(() => parseFilterQuery(route.query))
  const activeCount = computed(() => countActiveFilters(state.value.filter))

  watchEffect(() => {
    store.lastCatalogQuery = serializeFilterState(state.value)
  })

  async function push(next: CatalogState) {
    await router.push({ query: serializeFilterState(next) })
  }

  return {
    state,
    activeCount,
    setFilter: (patch: Partial<CatalogFilter>) =>
      push({ ...state.value, filter: { ...state.value.filter, ...patch }, page: 1 }),
    setSort: (sort: GameSortValue) => push({ ...state.value, sort, page: 1 }),
    setPage: (page: number) => push({ ...state.value, page }),
    clear: () => push({ filter: {}, sort: state.value.sort, page: 1 }),
  }
}
