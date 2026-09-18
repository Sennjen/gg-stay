import { describe, expect, it } from 'vitest'
import { useGameFilters } from '~/composables/useGameFilters'
import { useFiltersStore } from '~/stores/filters'

// `useGameFilters` only needs `useRoute`/`useRouter`/`useFiltersStore`, all of
// which are available directly in the Nuxt vitest environment; no host
// component is required to exercise the real router (verified: wrapping the
// composable in a `mountSuspended` host produced an app instance with its own
// router, detached from the one driven here, and read back stale/default
// state instead of the pushed route).

describe('useGameFilters', () => {
  it('parses the starting route into state and activeCount', async () => {
    const router = useRouter()
    await router.push('/?genres=rpg&page=3&sort=RELEASED_DESC')

    const filters = useGameFilters()

    expect(filters.state.value).toEqual({
      filter: { genres: ['rpg'] },
      sort: 'RELEASED_DESC',
      page: 3,
    })
    expect(filters.activeCount.value).toBe(1)
  })

  it('setFilter merges the patch, keeps other filters, and resets the page', async () => {
    const router = useRouter()
    await router.push('/?genres=rpg&page=3&sort=RELEASED_DESC')

    const filters = useGameFilters()
    await filters.setFilter({ platforms: [4] })

    expect(router.currentRoute.value.query).toEqual({
      genres: 'rpg',
      platforms: '4',
      sort: 'RELEASED_DESC',
    })
  })

  it('setSort resets the page and keeps filters; the default sort drops the key', async () => {
    const router = useRouter()
    await router.push('/?genres=rpg&page=3&sort=RELEASED_DESC')

    const filters = useGameFilters()
    await filters.setSort('NAME_ASC')

    expect(router.currentRoute.value.query).toEqual({ genres: 'rpg', sort: 'NAME_ASC' })

    await filters.setSort('POPULARITY_DESC')

    expect(router.currentRoute.value.query).toEqual({ genres: 'rpg' })
  })

  it('setPage keeps filters and sort and writes the page', async () => {
    const router = useRouter()
    await router.push('/?genres=rpg&sort=NAME_ASC')

    const filters = useGameFilters()
    await filters.setPage(2)

    expect(router.currentRoute.value.query).toEqual({ genres: 'rpg', sort: 'NAME_ASC', page: '2' })
  })

  it('clear removes every filter but keeps the current sort, and resets the page', async () => {
    const router = useRouter()
    await router.push('/?genres=rpg&stores=steam&sort=NAME_ASC&page=5')

    const filters = useGameFilters()
    await filters.clear()

    expect(router.currentRoute.value.query).toEqual({ sort: 'NAME_ASC' })
  })

  it('each change is a history entry: back() restores the previous query', async () => {
    const router = useRouter()
    await router.push('/?genres=rpg&page=3&sort=RELEASED_DESC')

    const filters = useGameFilters()
    await filters.setFilter({ platforms: [4] })
    const afterFirstChange = { ...router.currentRoute.value.query }

    await filters.setSort('NAME_ASC')
    expect(router.currentRoute.value.query).not.toEqual(afterFirstChange)

    await router.back()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(router.currentRoute.value.query).toEqual(afterFirstChange)
  })

  it('keeps the Pinia store in sync with the serialised current state', async () => {
    const router = useRouter()
    await router.push('/?genres=rpg&page=3&sort=RELEASED_DESC')

    const filters = useGameFilters()
    await filters.setFilter({ platforms: [4] })

    const store = useFiltersStore()
    expect(store.lastCatalogQuery).toEqual(router.currentRoute.value.query)
  })

  it('drops an invalid query value instead of echoing it back on the next change', async () => {
    const router = useRouter()
    await router.push('/?playtime=HUGE&genres=rpg')

    const filters = useGameFilters()
    expect(filters.state.value.filter).not.toHaveProperty('playtime')

    await filters.setPage(2)

    expect(router.currentRoute.value.query).toEqual({ genres: 'rpg', page: '2' })
  })
})
