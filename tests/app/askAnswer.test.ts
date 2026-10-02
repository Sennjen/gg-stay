import { describe, expect, it } from 'vitest'
import {
  ASK_MAX_LENGTH,
  askCatalogQuery,
  normaliseAskAnswer,
  normaliseAskQuery,
  parseRetryAfter,
  toCatalogFilter,
} from '~/utils/askAnswer'
import { FALLBACK_ANSWER, STRUCTURED_ANSWER } from '~~/tests/fixtures/ask/answers'

describe('normaliseAskQuery', () => {
  it('reads the first string of a route value and trims it', () => {
    expect(normaliseAskQuery('  co-op  ')).toBe('co-op')
    expect(normaliseAskQuery(['first', 'second'])).toBe('first')
    expect(normaliseAskQuery(undefined)).toBe('')
    expect(normaliseAskQuery(null)).toBe('')
    expect(normaliseAskQuery(['', 'x'])).toBe('')
  })

  it('keeps an over-long query whole, so the page can say it is too long', () => {
    const long = 'a'.repeat(ASK_MAX_LENGTH + 5)
    expect(normaliseAskQuery(long)).toBe(long)
  })
})

describe('parseRetryAfter', () => {
  it('reads whole seconds', () => {
    expect(parseRetryAfter('30')).toBe(30)
    expect(parseRetryAfter(' 5 ')).toBe(5)
  })

  it('never says "in 0 seconds"', () => {
    expect(parseRetryAfter('0')).toBe(1)
  })

  it('gives up on anything else rather than reading a clock for an HTTP date', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull()
    expect(parseRetryAfter('-3')).toBeNull()
    expect(parseRetryAfter('')).toBeNull()
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter(undefined)).toBeNull()
  })
})

describe('toCatalogFilter', () => {
  it('keeps what the catalog understands and drops nulls', () => {
    expect(
      toCatalogFilter({
        gameModes: ['LOCAL_COOP'],
        platforms: [7],
        priceMaxUah: 500,
        search: null,
        free: null,
      }),
    ).toEqual({ gameModes: ['LOCAL_COOP'], platforms: [7], priceMaxUah: 500 })
  })

  it('runs every value through the URL layer, so a bad one never reaches a chip', () => {
    expect(
      toCatalogFilter({
        gameModes: ['LOCAL_COOP', 'NOT_A_MODE'],
        genres: ['action', 'Bad Slug!'],
        priceMaxUah: -5,
        metacriticMin: 77,
        ukrainianLocalisation: 'KLINGON',
      }),
    ).toEqual({ gameModes: ['LOCAL_COOP'], genres: ['action'] })
  })

  it('answers an empty filter for anything that is not one', () => {
    expect(toCatalogFilter(null)).toEqual({})
    expect(toCatalogFilter('genres=action')).toEqual({})
    expect(toCatalogFilter({ genres: 'action' })).toEqual({})
  })
})

describe('askCatalogQuery', () => {
  it('takes the query of the catalog URL the answer names', () => {
    expect(askCatalogQuery(STRUCTURED_ANSWER.catalogUrl, {})).toEqual({
      platforms: '7',
      gameModes: 'LOCAL_COOP',
      priceMaxUah: '500',
    })
  })

  it('reads an absolute or English URL the same way: only its query is used', () => {
    expect(
      askCatalogQuery('https://gg-stay.example/en/games?genres=rpg&sort=RATING_DESC', {}),
    ).toEqual({ genres: 'rpg', sort: 'RATING_DESC' })
  })

  it('builds the query from the filter when the URL is not a catalog URL', () => {
    expect(askCatalogQuery('javascript:alert(1)', { genres: ['rpg'] })).toEqual({ genres: 'rpg' })
    expect(askCatalogQuery('/games/hades', { search: 'hades' })).toEqual({ search: 'hades' })
    expect(askCatalogQuery('', {})).toEqual({})
  })
})

describe('normaliseAskAnswer', () => {
  it('accepts the structured answer as sent', () => {
    const answer = normaliseAskAnswer(STRUCTURED_ANSWER)
    expect(answer?.mode).toBe('structured')
    expect(answer?.interpretation).toBe(STRUCTURED_ANSWER.interpretation)
    expect(answer?.filter).toEqual({ gameModes: ['LOCAL_COOP'], platforms: [7], priceMaxUah: 500 })
    expect(answer?.items.map((item) => [item.card.name, item.reason])).toEqual([
      ['Overcooked! 2', 'Хаотична кухня на двох за одним екраном'],
      ['It Takes Two', 'Створена лише для двох гравців'],
      ['Stardew Valley', 'Спокійна ферма, яку можна вести вдвох'],
    ])
  })

  it('accepts the fallback answer, which has no interpretation and no reasons', () => {
    const answer = normaliseAskAnswer(FALLBACK_ANSWER)
    expect(answer?.mode).toBe('fallback')
    expect(answer?.interpretation).toBeNull()
    expect(answer?.items.every((item) => item.reason === null)).toBe(true)
  })

  it('fills the card fields a card reads, so a lean card cannot break the grid', () => {
    const answer = normaliseAskAnswer({
      ...STRUCTURED_ANSWER,
      items: [{ card: { id: '9', slug: 'nine', name: 'Nine' }, reason: '' }],
    })
    expect(answer?.items[0]).toEqual({
      card: {
        id: '9',
        slug: 'nine',
        name: 'Nine',
        released: null,
        metacritic: null,
        cover: null,
        screenshots: [],
        platformFamilies: [],
        price: null,
        localisation: null,
        madeInUkraine: false,
      },
      reason: null,
    })
  })

  it('drops items that are not cards, and rejects an answer that is not one', () => {
    const answer = normaliseAskAnswer({
      ...STRUCTURED_ANSWER,
      items: [{ card: { id: '1' } }, null, ...STRUCTURED_ANSWER.items.slice(0, 1)],
    })
    expect(answer?.items).toHaveLength(1)
    expect(normaliseAskAnswer({ ...STRUCTURED_ANSWER, mode: 'magic' })).toBeNull()
    expect(normaliseAskAnswer({ ...STRUCTURED_ANSWER, items: 'none' })).toBeNull()
    expect(normaliseAskAnswer('<html>')).toBeNull()
    expect(normaliseAskAnswer(null)).toBeNull()
  })
})
