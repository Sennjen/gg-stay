import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { format, resolveConfig } from 'prettier'
import { renderReport, summarise, type CaseResult, type RunMeta } from './askReport'
import { readAnswer, readCases, scoreCase, type AskCase } from './askScore'

/**
 * The ask evaluation, run against a deployed site:
 *
 *   pnpm eval:ask --base-url https://gg-stay.vercel.app [--only id,id] [--concurrency 1]
 *
 * Every case of `evals/ask/cases.json` is posted to `POST /api/ask` exactly as written — no
 * suffix, no rewording — and the answer is scored (`askScore.ts`). The report goes to
 * `docs/llm/eval-<date>.md` and the raw answers to `docs/llm/runs/eval-<date>.json`.
 *
 * It calls the live model, so it costs money (about $0.25 for the thirty cases) and spends 30 of
 * the 40 model-backed answers one address gets per UTC day. The endpoint allows 10 requests a
 * minute per address, so requests start at least seven seconds apart, however many run at once.
 * A question asked within the last 24 h comes back from the response cache: such answers are
 * flagged (`tookMs` under 300 ms) rather than avoided, since changing the text would change the
 * question.
 */

/** The shortest gap between two request starts: 10 a minute, refilled one per 6 s, plus slack. */
export const MIN_GAP_MS = 7_000
/** How long one request may take; the endpoint answers within its own 15 s deadline. */
export const REQUEST_TIMEOUT_MS = 30_000
/** The longest `Retry-After` honoured before the one retry of a 429. */
const MAX_RETRY_AFTER_MS = 60_000

export interface EvalOptions {
  baseUrl: string
  only: string[] | null
  concurrency: number
}

export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export interface RunDeps {
  fetch: typeof globalThis.fetch
  clock: Clock
  log: (line: string) => void
}

const USAGE =
  'usage: pnpm eval:ask --base-url https://gg-stay.vercel.app [--only id,id] [--concurrency 1]'

export function parseArgs(argv: readonly string[]): EvalOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string
    if (arg === '--') continue
    const match = /^--(base-url|only|concurrency)(?:=(.*))?$/.exec(arg)
    if (!match) throw new Error(`unknown argument ${arg}\n${USAGE}`)
    const value = match[2] ?? argv[++index]
    if (value === undefined) throw new Error(`--${match[1]} needs a value\n${USAGE}`)
    values.set(match[1] as string, value)
  }

  const baseUrl = values.get('base-url')?.replace(/\/+$/, '')
  if (!baseUrl || !/^https?:\/\/[^/]+/.test(baseUrl))
    throw new Error(`--base-url is required\n${USAGE}`)

  const onlyRaw = values.get('only')
  const only =
    onlyRaw === undefined
      ? null
      : onlyRaw
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
  if (only && only.length === 0) throw new Error('--only names no case')

  const concurrency = Number(values.get('concurrency') ?? '1')
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error('--concurrency must be 1 or more')

  return { baseUrl, only, concurrency }
}

/** The named cases in the file's order; every case when `only` is `null`. */
export function selectCases(cases: readonly AskCase[], only: readonly string[] | null): AskCase[] {
  if (!only) return [...cases]
  const known = new Set(cases.map((testCase) => testCase.id))
  const unknown = only.filter((id) => !known.has(id))
  if (unknown.length) throw new Error(`unknown case id: ${unknown.join(', ')}`)
  return cases.filter((testCase) => only.includes(testCase.id))
}

/**
 * Waits until a request may start: the first at once, every later one at least `gapMs` after the
 * previous start. Each call reserves its slot, so concurrent callers queue up in call order.
 */
export function createPacer(gapMs: number, clock: Clock): () => Promise<void> {
  if (gapMs < MIN_GAP_MS) throw new Error(`the gap must be at least ${MIN_GAP_MS} ms`)
  let next = -Infinity
  return async () => {
    const now = clock.now()
    const slot = Math.max(now, next)
    next = slot + gapMs
    if (slot > now) await clock.sleep(slot - now)
  }
}

interface Attempt {
  status: number | null
  body: unknown
  error: string | null
  retryAfterMs: number | null
}

async function post(url: string, testCase: AskCase, deps: RunDeps): Promise<Attempt> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await deps.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ q: testCase.q, locale: testCase.locale }),
      signal: controller.signal,
    })
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      return { status: response.status, body: null, error: 'invalid JSON', retryAfterMs: null }
    }
    const retryAfter = Number(response.headers.get('retry-after'))
    return {
      status: response.status,
      body,
      error: response.status === 200 ? null : `HTTP ${response.status}`,
      retryAfterMs:
        response.status === 429
          ? Math.min(
              Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0,
              MAX_RETRY_AFTER_MS,
            )
          : null,
    }
  } catch (error) {
    const timedOut = controller.signal.aborted
    return {
      status: null,
      body: null,
      error: timedOut ? 'timeout' : error instanceof Error ? error.message : String(error),
      retryAfterMs: null,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function runOne(
  testCase: AskCase,
  url: string,
  pace: () => Promise<void>,
  deps: RunDeps,
): Promise<CaseResult> {
  await pace()
  const started = deps.clock.now()
  let attempts = 1
  let attempt = await post(url, testCase, deps)
  if (attempt.status === 429) {
    await deps.clock.sleep(attempt.retryAfterMs ?? 0)
    await pace()
    attempts++
    attempt = await post(url, testCase, deps)
  }
  const wallMs = deps.clock.now() - started

  const answer = attempt.status === 200 ? readAnswer(attempt.body) : null
  const error = attempt.error ?? (answer ? null : 'unexpected answer shape')
  return {
    id: testCase.id,
    q: testCase.q,
    locale: testCase.locale,
    topic: testCase.topic,
    startedAt: new Date(started).toISOString(),
    wallMs,
    attempts,
    httpStatus: attempt.status,
    error,
    answer: attempt.body,
    score: answer ? scoreCase(testCase, answer) : null,
  }
}

/** Runs the cases with at most `concurrency` in flight, paced; results in the cases' order. */
export async function runCases(
  cases: readonly AskCase[],
  options: { baseUrl: string; concurrency: number; gapMs?: number },
  deps: RunDeps,
): Promise<CaseResult[]> {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/api/ask`
  const pace = createPacer(options.gapMs ?? MIN_GAP_MS, deps.clock)
  const results: CaseResult[] = new Array(cases.length)
  let cursor = 0

  async function worker() {
    while (cursor < cases.length) {
      const index = cursor++
      const testCase = cases[index] as AskCase
      const result = await runOne(testCase, url, pace, deps)
      results[index] = result
      const outcome = result.score
        ? `${(result.answer as { mode: string }).mode}, ${result.score.pass ? 'pass' : 'FAIL'}`
        : result.error
      deps.log(`[${index + 1}/${cases.length}] ${testCase.id}: ${outcome} (${result.wallMs} ms)`)
    }
  }

  await Promise.all(Array.from({ length: Math.min(options.concurrency, cases.length) }, worker))
  return results
}

/** `eval-<date>`, or `eval-<date>-2`, `-3`… when an earlier run of the day has that name. */
export async function reportStem(
  date: string,
  taken: (stem: string) => boolean | Promise<boolean>,
): Promise<string> {
  let stem = `eval-${date}`
  for (let suffix = 2; await taken(stem); suffix++) stem = `eval-${date}-${suffix}`
  return stem
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

async function main(argv: readonly string[]): Promise<number> {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  let options: EvalOptions
  let cases: AskCase[]
  try {
    options = parseArgs(argv)
    const file = await readFile(join(root, 'evals/ask/cases.json'), 'utf8')
    cases = selectCases(readCases(JSON.parse(file)), options.only)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    return 2
  }

  console.log(
    `Asking ${options.baseUrl}/api/ask ${cases.length} questions, ${MIN_GAP_MS / 1000} s apart ` +
      `(about ${Math.ceil((cases.length * MIN_GAP_MS) / 60_000)} min or more). Each uncached ` +
      'answer is a paid model call and counts against the 40 per address per day.',
  )

  const startedAt = new Date()
  const results = await runCases(cases, options, { fetch, clock: systemClock, log: console.log })
  const finishedAt = new Date()

  const date = startedAt.toISOString().slice(0, 10)
  const meta: RunMeta = {
    date,
    baseUrl: options.baseUrl,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    gapMs: MIN_GAP_MS,
    only: options.only,
  }
  const totals = summarise(results)

  const docs = join(root, 'docs/llm')
  const runs = join(docs, 'runs')
  await mkdir(runs, { recursive: true })
  const stem = await reportStem(
    date,
    async (name) =>
      (await exists(join(docs, `${name}.md`))) || (await exists(join(runs, `${name}.json`))),
  )
  const markdownPath = join(docs, `${stem}.md`)
  const jsonPath = join(runs, `${stem}.json`)
  // Written as `pnpm format` would leave them, so the files can be committed as they are.
  const formatted = async (path: string, text: string) =>
    format(text, { ...(await resolveConfig(path)), filepath: path })
  await writeFile(markdownPath, await formatted(markdownPath, renderReport(meta, results, totals)))
  await writeFile(jsonPath, await formatted(jsonPath, JSON.stringify({ meta, totals, results })))

  console.log(
    `\n${totals.passed}/${totals.cases} cases passed, ${totals.structured}/${totals.answered} structured, ` +
      `field accuracy ${totals.fields.passed}/${totals.fields.total}.`,
  )
  console.log(`Report: ${markdownPath}\nRaw answers: ${jsonPath}`)
  console.log(
    `Cost is not visible over HTTP: sum costUsd of the [ask] lines in the Vercel logs of /api/ask ` +
      `from ${meta.startedAt} to ${meta.finishedAt} and fill in the "Cost (USD)" cell of the report.`,
  )
  return totals.errors > 0 ? 1 : 0
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2))
}
