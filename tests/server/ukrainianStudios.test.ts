import { describe, expect, it } from 'vitest'
import {
  UKRAINIAN_STUDIOS,
  UKRAINIAN_STUDIO_SLUGS,
  isMadeInUkraine,
} from '../../shared/ukrainianStudios'

describe('the Ukrainian studio list', () => {
  it('gives every studio a name, a city and at least one source', () => {
    for (const studio of UKRAINIAN_STUDIOS) {
      expect(studio.name.trim()).not.toBe('')
      expect(studio.city.trim()).not.toBe('')
      expect(studio.sources.length).toBeGreaterThan(0)
      for (const source of studio.sources) expect(source).toMatch(/^https?:\/\//)
    }
  })

  it('keeps names and slugs unique, and slugs in RAWG form', () => {
    const names = UKRAINIAN_STUDIOS.map((studio) => studio.name)
    expect(new Set(names).size).toBe(names.length)
    const all = UKRAINIAN_STUDIOS.flatMap((studio) => studio.rawgSlugs)
    expect(new Set(all).size).toBe(all.length)
    for (const slug of all) expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    expect(UKRAINIAN_STUDIO_SLUGS).toEqual(all)
  })

  it('is sorted by name, so a pull request adding a studio has one obvious place for it', () => {
    const names = UKRAINIAN_STUDIOS.map((studio) => studio.name.toLowerCase())
    expect(names).toEqual([...names].sort())
  })

  it('recognises a game by any of its developers', () => {
    expect(isMadeInUkraine(['gsc-game-world'])).toBe(true)
    expect(isMadeInUkraine(['valve-software', '4a-games'])).toBe(true)
    expect(isMadeInUkraine(['valve-software'])).toBe(false)
    expect(isMadeInUkraine([])).toBe(false)
  })

  it('does not list Ukrainian offices of foreign companies', () => {
    for (const slug of ['ubisoft-kiev', 'ubisoft-kyiv', 'crytek-kiev', 'plarium', 'gameloft']) {
      expect(UKRAINIAN_STUDIO_SLUGS).not.toContain(slug)
    }
  })
})
