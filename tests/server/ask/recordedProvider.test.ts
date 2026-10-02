import { describe, expect, it } from 'vitest'
import { normaliseQuery } from '../../../server/ask/normalise'
import { createRecordedProvider, type RecordedAnswers } from '../../../server/ask/recordedProvider'
import recorded from '../../fixtures/ask/recorded.json' with { type: 'json' }

const ANSWERS = recorded as RecordedAnswers

describe('normaliseQuery', () => {
  it.each([
    ['  Кооператив   для\tДВОХ ', 'кооператив для двох'],
    ['Co-Op\n\nFor Two', 'co-op for two'],
    // A decomposed "й" (и + combining breve) is the same query as the composed one.
    ['йгрa', 'йгрa'],
  ])('folds %j to %j', (raw, expected) => {
    expect(normaliseQuery(raw)).toBe(expected)
  })
})

describe('the recorded provider', () => {
  const provider = createRecordedProvider(async () => ANSWERS)

  it('answers a recorded query, whatever its case and spacing', async () => {
    const result = await provider.parse('  КООПЕРАТИВ для двох на switch до 500 грн ', 'uk', {
      genres: [],
    })
    expect(result).toMatchObject({
      ok: true,
      value: { gameModes: ['LOCAL_COOP'], platforms: ['NINTENDO'], priceMaxUah: 500 },
      usage: { calls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    })
  })

  it('answers the rerank of a recorded query', async () => {
    const result = await provider.rerank('атмосферний горор українською', [], 'uk')
    expect(result.ok && result.value.items.map((item) => item.id)).toEqual([
      '13537',
      '41494',
      '3328',
    ])
  })

  it('fails an unknown query with a typed failure, so fixture mode exercises the fallback', async () => {
    expect(await provider.parse('щось як Hades, але коротше', 'uk', { genres: [] })).toEqual({
      ok: false,
      failure: 'unrecorded',
      usage: { calls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    })
    expect(await provider.rerank('щось як Hades, але коротше', [], 'uk')).toMatchObject({
      ok: false,
      failure: 'unrecorded',
    })
  })

  it('reads recorded answers with the same lenient rules as a live one', async () => {
    const lenient = createRecordedProvider(async () => ({
      answers: [{ query: 'x', parse: { interpretation: 'X', gameModes: ['LOCAL_COOP', 'NOPE'] } }],
    }))
    expect(await lenient.parse('x', 'en', { genres: [] })).toMatchObject({
      ok: true,
      value: { gameModes: ['LOCAL_COOP'], platforms: [], interpretation: 'X' },
    })
    expect(await lenient.rerank('x', [], 'en')).toMatchObject({ ok: false, failure: 'unrecorded' })
  })

  it('fails every call when the fixture cannot be read', async () => {
    const missing = createRecordedProvider(async () => null)
    expect(await missing.parse('x', 'en', { genres: [] })).toMatchObject({
      ok: false,
      failure: 'unrecorded',
    })
    const broken = createRecordedProvider(async () => {
      throw new Error('no such asset')
    })
    expect(await broken.parse('x', 'en', { genres: [] })).toMatchObject({
      ok: false,
      failure: 'unrecorded',
    })
  })
})
