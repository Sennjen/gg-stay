import { normaliseQuery } from './normalise'
import { NO_USAGE, type LlmProvider, type LlmResult, type LlmUsage } from './provider'
import { readParse, readRerank } from './schemas'

/**
 * Answers recorded ahead of time, keyed by the normalised query: the provider of the tests and of
 * fixture mode, where no request may leave the machine. A query with no recording fails with
 * `unrecorded`, exactly as a live failure would, so fixture mode shows the fallback too.
 *
 * Recorded answers are read with the same lenient rules as a live one, and every call counts as
 * one call against the daily ceiling, at no cost — so a development server exercises the same
 * accounting a deployment does.
 */

export interface RecordedAnswer {
  query: string
  parse?: unknown
  rerank?: unknown
}

export interface RecordedAnswers {
  answers: RecordedAnswer[]
}

const RECORDED_CALL: LlmUsage = { ...NO_USAGE, calls: 1 }

export function createRecordedProvider(load: () => Promise<RecordedAnswers | null>): LlmProvider {
  let byQuery: Promise<Map<string, RecordedAnswer>> | undefined

  function answers(): Promise<Map<string, RecordedAnswer>> {
    byQuery ??= load()
      .then((recorded) => recorded?.answers ?? [])
      .catch(() => [])
      .then((list) => new Map(list.map((answer) => [normaliseQuery(answer.query), answer])))
    return byQuery
  }

  async function answer<T>(
    query: string,
    pick: (answer: RecordedAnswer) => unknown,
    read: (value: unknown) => T | null,
  ): Promise<LlmResult<T>> {
    const recorded = (await answers()).get(normaliseQuery(query))
    const raw = recorded ? pick(recorded) : undefined
    const value = raw === undefined ? null : read(raw)
    return value === null
      ? { ok: false, failure: 'unrecorded', usage: RECORDED_CALL }
      : { ok: true, value, usage: RECORDED_CALL }
  }

  return {
    name: 'recorded',
    parse: (query) => answer(query, (recorded) => recorded.parse, readParse),
    rerank: (query) => answer(query, (recorded) => recorded.rerank, readRerank),
  }
}
