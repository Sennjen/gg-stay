import { describe, expect, it } from 'vitest'
import { buildIndexPlan } from '../../../server/index/buildPlan'
import { MAX_SLUG_LENGTH, daysSinceEpoch, isIndexableSlug } from '../../../server/index/document'
import { orderKey, rangeKey } from '../../../server/index/keys'
import { FIXTURE_GAMES } from '../../fixtures/index/games'

const plan = buildIndexPlan(1, FIXTURE_GAMES)

function order(sort: Parameters<typeof orderKey>[1]): [number, number][] {
  return plan.orders.get(orderKey(1, sort))!
}

function range(field: Parameters<typeof rangeKey>[1]): Map<number, number> {
  return new Map(plan.ranges.get(rangeKey(1, field))!)
}

describe('buildIndexPlan', () => {
  it('keeps one document per game', () => {
    expect(plan.docs.size).toBe(FIXTURE_GAMES.length)
    expect(plan.docs.get(3)?.name).toBe('Gamma Ray')
  })

  it('scores every order set with a dense rank, so no two members tie', () => {
    for (const [key, entries] of plan.orders) {
      const ranks = entries.map(([, rank]) => rank)
      expect(new Set(ranks).size, key).toBe(entries.length)
      expect([...ranks].sort((a, b) => a - b)).toEqual(entries.map((_, index) => index))
    }
  })

  it('bakes the tie-break into the rank, so both directions agree on tied members', () => {
    const ascending = order('PRICE_ASC')
      .slice()
      .sort((left, right) => left[1] - right[1])
      .map(([id]) => id)
    const descending = order('PRICE_DESC')
      .slice()
      .sort((left, right) => left[1] - right[1])
      .map(([id]) => id)
    // 28 and 36 are both free; 28 is the more popular. They stay in that order either way.
    expect(ascending.slice(0, 2)).toEqual([28, 36])
    expect(descending.slice(-2)).toEqual([28, 36])
  })

  it('leaves games without a price out of the price and discount orders and ranges', () => {
    const priced = FIXTURE_GAMES.filter((game) => game.priceUah !== null).map((game) => game.id)
    expect(order('PRICE_ASC')).toHaveLength(priced.length)
    expect(order('PRICE_DESC')).toHaveLength(priced.length)
    expect(order('DISCOUNT_DESC')).toHaveLength(priced.length)
    expect([...range('price').keys()].sort((a, b) => a - b)).toEqual(priced)
    expect([...range('discount').keys()].sort((a, b) => a - b)).toEqual(priced)
  })

  it('leaves games without a release date out of the release orders and range', () => {
    const dated = FIXTURE_GAMES.filter((game) => game.released !== null).length
    expect(order('RELEASED_ASC')).toHaveLength(dated)
    expect(order('RELEASED_DESC')).toHaveLength(dated)
    expect(range('released').size).toBe(dated)
    expect(range('released').has(14)).toBe(false)
  })

  it('scores the release range in whole days since the epoch', () => {
    expect(range('released').get(10)).toBe(daysSinceEpoch('2015-03-10'))
    expect(range('released').get(10)).toBe(16_504)
  })

  it('scores the rating range as an integer of hundredths', () => {
    expect(range('rating').get(20)).toBe(480)
    expect(range('rating').get(22)).toBe(390)
  })

  it('keeps unscored games in the rating and Metacritic ranges at zero', () => {
    expect(range('metacritic').get(23)).toBe(0)
    expect(range('rating').get(23)).toBe(0)
  })

  it('keeps every score a safe integer well below 2^53', () => {
    for (const entries of [...plan.orders.values(), ...plan.ranges.values()]) {
      for (const [, score] of entries) {
        expect(Number.isSafeInteger(score)).toBe(true)
        expect(Math.abs(score)).toBeLessThan(2 ** 40)
      }
    }
  })

  it('folds the names once, for the search to read', () => {
    expect(plan.names.get(35)).toBe('kite keep')
    expect(plan.names.size).toBe(FIXTURE_GAMES.length)
  })

  it('files every game under its own slug, spelled as the document spells it', () => {
    expect(plan.slugs.size).toBe(FIXTURE_GAMES.length)
    expect(plan.slugs.get('kite-keep')).toBe(35)
    for (const game of FIXTURE_GAMES) expect(plan.slugs.get(game.slug), game.slug).toBe(game.id)

    // Not folded as the names are: a slug is matched exactly, so it is stored exactly.
    const mixed = buildIndexPlan(1, [
      { ...FIXTURE_GAMES[0]!, slug: 'Kite-Keep' },
      { ...FIXTURE_GAMES[1]!, slug: 'kite-keep' },
      { ...FIXTURE_GAMES[2]!, slug: ' padded ' },
    ])
    expect(mixed.slugs).toEqual(
      new Map([
        ['Kite-Keep', 1],
        ['kite-keep', 2],
        [' padded ', 3],
      ]),
    )
  })

  it('gives a slug two games claim to the more popular one, then to the lower id', () => {
    const claim = (id: number, slug: string, popularity: number) => ({
      ...FIXTURE_GAMES.find((game) => game.id === id)!,
      slug,
      popularity,
    })
    const games = [
      claim(3, 'twice', 10),
      claim(1, 'twice', 90),
      claim(2, 'twice', 90),
      claim(5, 'tied', 40),
      claim(4, 'tied', 40),
    ]
    // The same answer whatever order a run lists the games in: the rule, not the arrival order.
    for (const order of [games, [...games].reverse()]) {
      const slugs = buildIndexPlan(1, order).slugs
      expect(slugs.get('twice')).toBe(1)
      expect(slugs.get('tied')).toBe(4)
      expect(slugs.size).toBe(2)
    }
    // The documents are all still there; only the slug has a single owner.
    expect(buildIndexPlan(1, games).docs.size).toBe(5)
  })

  it('files a slug only under a document the version stores', () => {
    // The same id listed twice keeps its last document, and only that document's slug.
    const slugs = buildIndexPlan(1, [
      { ...FIXTURE_GAMES[0]!, slug: 'old-slug' },
      { ...FIXTURE_GAMES[0]!, slug: 'new-slug' },
    ]).slugs
    expect(slugs).toEqual(new Map([['new-slug', 1]]))
  })

  it('files no slug a lookup would refuse: empty, over-long or not well-formed', () => {
    const longest = 'a'.repeat(MAX_SLUG_LENGTH)
    const bounded = buildIndexPlan(1, [
      { ...FIXTURE_GAMES[0]!, slug: longest },
      { ...FIXTURE_GAMES[1]!, slug: `${longest}a` },
      { ...FIXTURE_GAMES[2]!, slug: 'half-\ud83d-emoji' },
      { ...FIXTURE_GAMES[3]!, slug: '' },
    ])
    expect(bounded.slugs).toEqual(new Map([[longest, 1]]))
    // The games themselves are planned like any other: documents, names, orders.
    expect(bounded.docs.size).toBe(4)
    expect(bounded.names.size).toBe(4)
  })

  it('orders names with a Ukrainian collator', () => {
    const byRank = order('NAME_ASC')
      .slice()
      .sort((left, right) => left[1] - right[1])
      .map(([id]) => id)
    expect(byRank.slice(0, 4)).toEqual([1, 25, 26, 2])
    expect(byRank).toHaveLength(FIXTURE_GAMES.length)
  })

  it('writes no per-year facet', () => {
    for (const key of plan.facets.keys()) expect(key).not.toContain(':f:year:')
  })

  it('namespaces every key it produces under the version', () => {
    for (const key of [...plan.facets.keys(), ...plan.orders.keys(), ...plan.ranges.keys()]) {
      expect(key.startsWith('idx:v1:')).toBe(true)
    }
  })
})

/**
 * The one rule about which slugs the index deals in at all, applied by the plan when it files them
 * and by both adapters before they look one up.
 */
describe('isIndexableSlug', () => {
  it('takes every slug RAWG writes, up to two hundred characters', () => {
    expect(MAX_SLUG_LENGTH).toBe(200)
    for (const game of FIXTURE_GAMES) expect(isIndexableSlug(game.slug), game.slug).toBe(true)
    expect(isIndexableSlug('the-witcher-3-wild-hunt')).toBe(true)
    expect(isIndexableSlug('a')).toBe(true)
    expect(isIndexableSlug('a'.repeat(MAX_SLUG_LENGTH))).toBe(true)
  })

  it('refuses an empty slug and one a character past the bound', () => {
    expect(isIndexableSlug('')).toBe(false)
    expect(isIndexableSlug('a'.repeat(MAX_SLUG_LENGTH + 1))).toBe(false)
    expect(isIndexableSlug('a'.repeat(1_000_000))).toBe(false)
  })

  it('measures the bound in UTF-16 code units, the length a string reports', () => {
    // An emoji is two units, so a hundred of them are exactly at the bound.
    expect(isIndexableSlug('\u{1F3AE}'.repeat(MAX_SLUG_LENGTH / 2))).toBe(true)
    expect(isIndexableSlug('\u{1F3AE}'.repeat(MAX_SLUG_LENGTH / 2 + 1))).toBe(false)
  })

  it('refuses text that is not well-formed, and nothing else for what it is made of', () => {
    expect(isIndexableSlug('half-\ud83d-emoji')).toBe(false)
    expect(isIndexableSlug('\udc00')).toBe(false)
    // Whole characters of any kind are fine: the match is exact, so an odd slug simply misses.
    for (const slug of [
      'Kite-Keep',
      'nier:automata',
      'a b',
      '50%25-off',
      'pokémon-snap',
      '\u{1F3AE}',
    ]) {
      expect(isIndexableSlug(slug), slug).toBe(true)
    }
  })
})
