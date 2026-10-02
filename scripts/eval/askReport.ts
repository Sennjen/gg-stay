import type { AskLocale } from '../../server/ask/schemas'
import { REASON_MAX_CHARS, type CaseScore, type Check, type FieldValue } from './askScore'

/**
 * The totals of an evaluation run and its Markdown report (`docs/llm/eval-<date>.md`).
 */

/** One case as it ran: the raw body exactly as received, and its score when it was an answer. */
export interface CaseResult {
  id: string
  q: string
  locale: AskLocale
  topic: string
  startedAt: string
  /** Client-side time from sending the request to reading the body, retries included. */
  wallMs: number
  attempts: number
  httpStatus: number | null
  error: string | null
  answer: unknown
  score: CaseScore | null
}

export interface RunMeta {
  date: string
  baseUrl: string
  startedAt: string
  finishedAt: string
  gapMs: number
  only: string[] | null
}

export interface Rate {
  passed: number
  total: number
  /** `null` when nothing was measured. */
  rate: number | null
}

export interface Latency {
  p50: number | null
  p95: number | null
}

export interface Totals {
  cases: number
  answered: number
  errors: number
  structured: number
  passed: number
  structuredRate: number | null
  mode: Rate
  fields: Rate
  tags: Rate
  items: Rate
  reasons: Rate
  reasonLength: Rate
  reasonPlain: Rate
  language: Rate
  leak: Rate
  tookMs: Latency
  wallMs: Latency
  cacheSuspected: number
}

/** Nearest-rank percentile; `null` without samples. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(Math.ceil((p / 100) * sorted.length), 1)
  return sorted[rank - 1] ?? null
}

function rate(passed: number, total: number): Rate {
  return { passed, total, rate: total > 0 ? passed / total : null }
}

function checkRate(scores: CaseScore[], pick: (score: CaseScore) => Check): Rate {
  const applicable = scores.map(pick).filter((check) => check.pass !== null)
  return rate(applicable.filter((check) => check.pass).length, applicable.length)
}

function latency(values: number[]): Latency {
  return { p50: percentile(values, 50), p95: percentile(values, 95) }
}

export function summarise(results: readonly CaseResult[]): Totals {
  const answered = results.filter((result) => result.score !== null)
  const scores = answered.map((result) => result.score as CaseScore)
  const structured = answered.filter(
    (result) => (result.answer as { mode?: unknown }).mode === 'structured',
  )
  const fieldChecks = scores.flatMap((score) => score.fields)
  const structuredScores = structured.map((result) => result.score as CaseScore)

  return {
    cases: results.length,
    answered: answered.length,
    errors: results.length - answered.length,
    structured: structured.length,
    passed: scores.filter((score) => score.pass).length,
    structuredRate: answered.length ? structured.length / answered.length : null,
    mode: checkRate(scores, (score) => score.mode),
    fields: rate(fieldChecks.filter((field) => field.pass).length, fieldChecks.length),
    tags: checkRate(scores, (score) => score.tags),
    items: checkRate(scores, (score) => score.items),
    reasons: rate(
      structuredScores.reduce((sum, score) => sum + score.reasons.present, 0),
      structuredScores.reduce((sum, score) => sum + score.reasons.total, 0),
    ),
    reasonLength: checkRate(scores, (score) => score.reasonLength),
    reasonPlain: checkRate(scores, (score) => score.reasonPlain),
    language: checkRate(scores, (score) => score.language),
    leak: checkRate(scores, (score) => score.leak),
    tookMs: latency(answered.map((result) => (result.answer as { tookMs: number }).tookMs)),
    wallMs: latency(answered.map((result) => result.wallMs)),
    cacheSuspected: scores.filter((score) => score.fromCacheSuspected).length,
  }
}

// ---------------------------------------------------------------------------------------------
// Markdown

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

const mark = (check: Check) => (check.pass === null ? '–' : check.pass ? '✓' : '✗')

const percent = ({ passed, total, rate: value }: Rate) =>
  value === null ? '–' : `${Math.round(value * 100)} % (${passed}/${total})`

const ms = ({ p50, p95 }: Latency) => (p50 === null || p95 === null ? '–' : `${p50} / ${p95} ms`)

const shown = (value: FieldValue | null | { anyOf: FieldValue[] }) =>
  value === null ? '—' : JSON.stringify(value)

function caseRow(result: CaseResult, index: number): string {
  const { score } = result
  const answer = result.answer as { mode?: string; tookMs?: number } | null
  const head = `| ${index + 1} | ${result.id} | ${result.locale} | ${cell(result.q)} |`
  if (!score) return `${head} ${cell(result.error ?? 'no answer')} | | | | | | | | | | ✗ |`
  const fields = score.fields
  const passedFields = fields.filter((field) => field.pass).length
  const cached = score.fromCacheSuspected ? ' (cache?)' : ''
  return [
    head,
    ` ${answer?.mode ?? '?'} ${mark(score.mode)} |`,
    ` ${fields.length ? `${passedFields}/${fields.length}` : '–'} |`,
    ` ${mark(score.tags)} |`,
    ` ${score.items.count} ${mark(score.items)} |`,
    ` ${score.reasons.present}/${score.reasons.total} |`,
    ` ${mark(score.reasonLength)} |`,
    ` ${mark(score.reasonPlain)} |`,
    ` ${mark(score.language)} |`,
    ` ${mark(score.leak)} |`,
    ` ${answer?.tookMs ?? '?'}${cached} |`,
    ` ${score.pass ? '✓' : '✗'} |`,
  ].join('')
}

function failureLines(result: CaseResult): string[] {
  const { score } = result
  if (!score) return [`- **${result.id}**: ${result.error ?? 'no answer'}`]
  if (score.pass) return []
  const problems = [
    ...score.fields
      .filter((field) => !field.pass)
      .map((field) =>
        field.kind === 'must'
          ? `${field.field}: expected ${shown(field.expected)}, got ${shown(field.actual)}`
          : `${field.field} must be unset, got ${shown(field.actual)}`,
      ),
    ...(
      [
        ['mode', score.mode],
        ['tags', score.tags],
        ['items', score.items],
        [`reason over ${REASON_MAX_CHARS} chars`, score.reasonLength],
        ['reason echoes the filter', score.reasonPlain],
        ['interpretation language', score.language],
        ['prompt leak', score.leak],
      ] as [string, Check][]
    )
      .filter(([, check]) => check.pass === false)
      .map(([name, check]) => (check.detail ? `${name}: ${cell(check.detail)}` : name)),
  ]
  return [`- **${result.id}**: ${problems.join('; ')}`]
}

export function renderReport(
  meta: RunMeta,
  results: readonly CaseResult[],
  totals: Totals,
): string {
  const failures = results.flatMap(failureLines)
  return [
    `# Ask evaluation — ${meta.date}`,
    '',
    `- Endpoint: \`${meta.baseUrl}/api/ask\``,
    `- Run: ${meta.startedAt} → ${meta.finishedAt} (UTC), at least ${meta.gapMs / 1000} s between requests`,
    `- Cases: ${meta.only ? `only ${meta.only.join(', ')}` : 'all'}`,
    '',
    '## Totals',
    '',
    '| Measure | Value |',
    '| --- | --- |',
    `| Cases passed | ${percent(rate(totals.passed, totals.cases))} |`,
    `| Answered (HTTP 200 with an answer) | ${totals.answered}/${totals.cases} |`,
    `| Structured rate | ${percent(rate(totals.structured, totals.answered))} |`,
    `| Mode as expected | ${percent(totals.mode)} |`,
    `| Field accuracy (must + mustNot checks) | ${percent(totals.fields)} |`,
    `| Tag accuracy (cases with tagsAny) | ${percent(totals.tags)} |`,
    `| Item count within bounds | ${percent(totals.items)} |`,
    `| Reasons coverage (cards of structured answers) | ${percent(totals.reasons)} |`,
    `| Reasons ≤ ${REASON_MAX_CHARS} chars (cases) | ${percent(totals.reasonLength)} |`,
    `| Reasons free of codes, prices, platforms (cases) | ${percent(totals.reasonPlain)} |`,
    `| Interpretation in the case's language | ${percent(totals.language)} |`,
    `| No prompt leak (injection, off-topic) | ${percent(totals.leak)} |`,
    `| Latency p50 / p95 (tookMs) | ${ms(totals.tookMs)} |`,
    `| Latency p50 / p95 (client wall time) | ${ms(totals.wallMs)} |`,
    `| Answers suspected from the response cache (tookMs < 300) | ${totals.cacheSuspected} |`,
    `| Cost (USD) | _fill in_ |`,
    '',
    'Cost is not visible over HTTP. Sum `costUsd` of the `[ask]` lines in the Vercel function logs',
    `of \`/api/ask\` between ${meta.startedAt} and ${meta.finishedAt}, and write it in the cell above.`,
    '',
    '## Cases',
    '',
    `| # | id | locale | query | mode | fields | tags | items | reasons | ≤ ${REASON_MAX_CHARS} | plain | lang | leak | tookMs | pass |`,
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.map(caseRow),
    '',
    '✓ passed, ✗ failed, – not applicable. Fields: passed must/mustNot checks of the case.',
    '',
    '## Failures',
    '',
    ...(failures.length ? failures : ['None.']),
    '',
  ].join('\n')
}
