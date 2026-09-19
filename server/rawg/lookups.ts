import { PLATFORM_FAMILIES } from '../../shared/catalog'
import {
  STORE_OPTIONS,
  type AgeRatingValue,
  type GameModeValue,
  type PlatformFamilyValue,
  type PlaytimeValue,
} from '../../shared/catalog'

const ESRB_TO_PEGI: Record<string, AgeRatingValue> = {
  everyone: 'PEGI3',
  'everyone-10-plus': 'PEGI7',
  teen: 'PEGI12',
  mature: 'PEGI18',
  'adults-only': 'PEGI18',
}

// ESRB has no rating between "Teen" and "Mature" — there is no ESRB equivalent of PEGI 16 — so
// PEGI12 and PEGI16 both map to the same ESRB slug ('teen'). A search for either PEGI band
// returns the same RAWG results; this is a real gap in RAWG's data, not a bug here.
const PEGI_TO_ESRB: Record<AgeRatingValue, string[]> = {
  PEGI3: ['everyone'],
  PEGI7: ['everyone', 'everyone-10-plus'],
  PEGI12: ['teen'],
  PEGI16: ['teen'],
  PEGI18: ['mature', 'adults-only'],
}

const MODE_TO_TAG: Record<GameModeValue, string> = {
  SINGLE: 'singleplayer',
  LOCAL_COOP: 'local-co-op',
  ONLINE_COOP: 'online-co-op',
  MULTIPLAYER: 'multiplayer',
}

export function esrbToAgeRating(slug: string | null | undefined): AgeRatingValue | null {
  return (slug && ESRB_TO_PEGI[slug]) || null
}

export function esrbSlugsForAgeRatings(ratings: readonly AgeRatingValue[]): string[] {
  return [...new Set(ratings.flatMap((rating) => PEGI_TO_ESRB[rating]))]
}

export function tagsForGameModes(modes: readonly GameModeValue[]): string[] {
  return modes.map((mode) => MODE_TO_TAG[mode])
}

export function gameModesFromTags(tagSlugs: readonly string[]): GameModeValue[] {
  const present = new Set(tagSlugs)
  return (Object.keys(MODE_TO_TAG) as GameModeValue[]).filter((mode) =>
    present.has(MODE_TO_TAG[mode]),
  )
}

export function matchesPlaytime(hours: number | null | undefined, bucket: PlaytimeValue): boolean {
  if (!hours || hours <= 0) return false
  if (bucket === 'SHORT') return hours < 10
  if (bucket === 'MEDIUM') return hours >= 10 && hours <= 40
  return hours > 40
}

export function storeIdsFromSlugs(slugs: readonly string[]): number[] {
  return slugs.flatMap((slug) => {
    const store = STORE_OPTIONS.find((option) => option.slug === slug)
    return store ? [store.id] : []
  })
}

export function storeSlugFromId(id: number | null | undefined): string | null {
  return STORE_OPTIONS.find((option) => option.id === id)?.slug ?? null
}

const FAMILY_PREFIXES: [prefix: string, family: PlatformFamilyValue][] = [
  ['pc', 'PC'],
  ['playstation', 'PLAYSTATION'],
  ['xbox', 'XBOX'],
  ['nintendo', 'NINTENDO'],
  ['ios', 'MOBILE'],
  ['android', 'MOBILE'],
]

/** RAWG platform (or parent-platform) slug, e.g. "playstation5" or "nintendo-switch", to family. */
export function platformFamilyFromSlug(slug: string | null | undefined): PlatformFamilyValue {
  if (!slug) return 'OTHER'
  const match = FAMILY_PREFIXES.find(([prefix]) => slug.startsWith(prefix))
  return match ? match[1] : 'OTHER'
}

/** De-duplicates and orders families by the enum's declaration order (PC, PLAYSTATION, …). */
export function platformFamiliesFromSlugs(
  slugs: readonly (string | null | undefined)[],
): PlatformFamilyValue[] {
  const present = new Set(slugs.map(platformFamilyFromSlug))
  return PLATFORM_FAMILIES.filter((family) => present.has(family))
}
