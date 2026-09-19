// Every field is optional: hand-written fixtures may differ from live RAWG payloads.
export interface RawgTaxonomy {
  id?: number
  slug?: string
  name?: string
}

export interface RawgShortScreenshot {
  id?: number
  image?: string | null
}

export interface RawgGameListItem {
  id?: number
  slug?: string
  name?: string
  released?: string | null
  background_image?: string | null
  rating?: number | null
  ratings_count?: number | null
  metacritic?: number | null
  playtime?: number | null
  added?: number | null
  platforms?: { platform?: RawgTaxonomy }[] | null
  parent_platforms?: { platform?: RawgTaxonomy }[] | null
  short_screenshots?: RawgShortScreenshot[] | null
  genres?: RawgTaxonomy[] | null
  tags?: RawgTaxonomy[] | null
  stores?: { store?: RawgTaxonomy }[] | null
  esrb_rating?: RawgTaxonomy | null
}

export interface RawgGameDetail extends RawgGameListItem {
  description_raw?: string | null
  website?: string | null
  developers?: RawgTaxonomy[] | null
  publishers?: RawgTaxonomy[] | null
}

export interface RawgStoreLink {
  id?: number
  store_id?: number
  url?: string | null
}

export interface RawgScreenshot {
  id?: number
  image?: string | null
  width?: number | null
  height?: number | null
}

export interface RawgList<T> {
  count?: number
  next?: string | null
  results?: T[] | null
}
