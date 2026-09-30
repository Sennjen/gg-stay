import studios from '../data/ukrainian-studios.json'

/**
 * Studios that count as "made in Ukraine": founded in Ukraine, with the main development team
 * working there. Ukrainian offices of foreign companies and outsourcing houses are not listed.
 * The list is data — `data/ukrainian-studios.json`, with a source for every entry.
 */
export interface UkrainianStudio {
  name: string
  rawgSlugs: string[]
  city: string
  founded: number | null
  status: 'active' | 'defunct'
  notableGames: string[]
  sources: string[]
}

export const UKRAINIAN_STUDIOS: readonly UkrainianStudio[] = studios as UkrainianStudio[]

const SLUGS = new Set(UKRAINIAN_STUDIOS.flatMap((studio) => studio.rawgSlugs))

/** Every RAWG developer slug on the list, in list order. */
export const UKRAINIAN_STUDIO_SLUGS: readonly string[] = [...SLUGS]

/** True when any of a game's RAWG developer slugs belongs to a Ukrainian studio. */
export function isMadeInUkraine(developerSlugs: readonly string[]): boolean {
  return developerSlugs.some((slug) => SLUGS.has(slug))
}
