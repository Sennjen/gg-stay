import { describe, expect, it } from 'vitest'
import {
  percentile,
  renderReport,
  summarise,
  type CaseResult,
  type RunMeta,
} from '../../../scripts/eval/askReport'
import { readAnswer, scoreCase, type AskCase } from '../../../scripts/eval/askScore'
import recorded from '../../fixtures/eval/ask-answers.json' with { type: 'json' }

/** Totals and the Markdown report of a run, from recorded answers. */

const COOP: AskCase = {
  id: 'uk-coop-switch-price',
  q: 'кооператив для двох на Switch до 500 грн',
  locale: 'uk',
  topic: 'platform + price',
  expect: {
    mode: 'structured',
    must: { platforms: [7], gameModes: ['LOCAL_COOP'], priceMaxUah: 500 },
    mustNot: ['free'],
  },
}

const HORROR: AskCase = {
  id: 'en-horror',
  q: 'atmospheric horror | on PC',
  locale: 'en',
  topic: 'mood tag',
  expect: { mode: 'structured', must: { platforms: [4] }, tagsAny: ['horror'] },
}

function result(testCase: AskCase, body: unknown, patch: Partial<CaseResult> = {}): CaseResult {
  const answer = readAnswer(body)
  return {
    id: testCase.id,
    q: testCase.q,
    locale: testCase.locale,
    topic: testCase.topic,
    startedAt: '2026-10-03T10:00:00.000Z',
    wallMs: 5000,
    attempts: 1,
    httpStatus: 200,
    error: null,
    answer: body,
    score: answer ? scoreCase(testCase, answer) : null,
    ...patch,
  }
}

const META: RunMeta = {
  date: '2026-10-03',
  baseUrl: 'https://example.test',
  startedAt: '2026-10-03T10:00:00.000Z',
  finishedAt: '2026-10-03T10:04:00.000Z',
  gapMs: 7000,
  only: null,
}

const RESULTS: CaseResult[] = [
  result(COOP, recorded.coopSwitch),
  result(HORROR, recorded.horrorEn, { wallMs: 6000 }),
  result(COOP, recorded.fallback, { wallMs: 9500 }),
  result(HORROR, null, { httpStatus: 429, error: 'HTTP 429', answer: null, wallMs: 100 }),
]

describe('percentile', () => {
  it('takes the nearest rank', () => {
    const values = [400, 100, 300, 200, 1000]
    expect(percentile(values, 50)).toBe(300)
    expect(percentile(values, 95)).toBe(1000)
    expect(percentile([7], 95)).toBe(7)
  })

  it('has no value for no samples', () => {
    expect(percentile([], 50)).toBeNull()
  })
})

describe('summarise', () => {
  const totals = summarise(RESULTS)

  it('counts answered, structured and passing cases', () => {
    expect(totals).toMatchObject({ cases: 4, answered: 3, errors: 1, structured: 2, passed: 2 })
    expect(totals.structuredRate).toBeCloseTo(2 / 3)
  })

  it('pools the field checks of every answered case', () => {
    // coop: 4/4, horror: 1/1, fallback: 1/4 (only `free` is unset).
    expect(totals.fields).toEqual({ passed: 6, total: 9, rate: 6 / 9 })
  })

  it('scores tags only where a case asks for them', () => {
    expect(totals.tags).toEqual({ passed: 1, total: 1, rate: 1 })
  })

  it('measures reason coverage over the cards of structured answers', () => {
    expect(totals.reasons).toEqual({ passed: 5, total: 6, rate: 5 / 6 })
  })

  it('reports latency from the server’s tookMs and the client’s wall time', () => {
    expect(totals.tookMs).toEqual({ p50: 5120, p95: 9030 })
    expect(totals.wallMs).toEqual({ p50: 6000, p95: 9500 })
    expect(totals.cacheSuspected).toBe(0)
  })

  it('has no rates when nothing was answered', () => {
    const empty = summarise([RESULTS[3]!])
    expect(empty.structuredRate).toBeNull()
    expect(empty.fields.rate).toBeNull()
    expect(empty.tookMs).toEqual({ p50: null, p95: null })
  })
})

describe('renderReport', () => {
  const markdown = renderReport(META, RESULTS, summarise(RESULTS))

  it('has a row per case, with the query’s pipes escaped', () => {
    expect(markdown).toContain('| 1 | uk-coop-switch-price |')
    expect(markdown).toContain('atmospheric horror \\| on PC')
    expect(markdown.match(/^\| \d+ \|/gm)).toHaveLength(4)
  })

  it('names what failed and why', () => {
    expect(markdown).toContain('gameModes: expected ["LOCAL_COOP"], got —')
    expect(markdown).toContain('HTTP 429')
  })

  it('leaves a cell for the cost and says where to read it', () => {
    expect(markdown).toMatch(/Cost \(USD\) \| _fill in_/)
    expect(markdown).toContain('costUsd')
    expect(markdown).toContain('2026-10-03T10:00:00.000Z')
  })

  it('states the totals', () => {
    expect(markdown).toContain('| Structured rate | 67 % (2/3) |')
    expect(markdown).toContain('| Latency p50 / p95 (tookMs) | 5120 / 9030 ms |')
  })
})
