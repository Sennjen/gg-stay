import type { GameFilter, GameSort } from '../graphql/__generated__/resolvers-types'
import type { RawgParams } from './rawgFetch'
import { storeIdsFromSlugs, tagsForGameModes } from './lookups'

const ORDERING: Record<GameSort, string> = {
  POPULARITY_DESC: '-added',
  RATING_DESC: '-rating',
  METACRITIC_DESC: '-metacritic',
  RELEASED_DESC: '-released',
  RELEASED_ASC: 'released',
  NAME_ASC: 'name',
  // Price sorts need the nightly index; fall back to popularity until it exists.
  PRICE_ASC: '-added',
  PRICE_DESC: '-added',
  DISCOUNT_DESC: '-added',
}

export interface FilterToParamsInput {
  filter?: GameFilter | null
  sort: GameSort
  page: number
  pageSize: number
  today: string
}

function nextDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

function join(values?: readonly (string | number)[] | null): string | undefined {
  return values && values.length > 0 ? values.join(',') : undefined
}

export function filterToParams({
  filter,
  sort,
  page,
  pageSize,
  today,
}: FilterToParamsInput): RawgParams {
  const f = filter ?? {}
  const params: RawgParams = { ordering: ORDERING[sort], page, page_size: pageSize }

  const search = f.search?.trim()
  if (search) params.search = search

  params.genres = join(f.genres)
  params.platforms = join(f.platforms)
  params.developers = join(f.developers)
  params.publishers = join(f.publishers)
  params.stores = join(storeIdsFromSlugs(f.stores ?? []))
  params.tags = join([...tagsForGameModes(f.gameModes ?? []), ...(f.tags ?? [])])

  if (f.upcoming) {
    params.dates = `${nextDay(today)},2099-12-31`
  } else if (f.yearFrom || f.yearTo) {
    params.dates = `${f.yearFrom ?? 1970}-01-01,${f.yearTo ?? 2099}-12-31`
  }

  if (f.metacriticMin) params.metacritic = `${f.metacriticMin},100`

  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  ) as RawgParams
}
