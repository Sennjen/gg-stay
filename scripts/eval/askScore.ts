import { DEFAULT_SORT, parseFilterQuery } from '../../shared/filterUrl'
import { isMoodTag, type MoodTag } from '../../shared/moodTags'
import { parseSystemPrompt, RAWG_GENRES, RERANK_SYSTEM_PROMPT } from '../../server/ask/prompts'
import { plainReason } from '../../server/ask/sanitise'
import { ASK_LOCALES, AskParseSchema, MAX_ANSWERS, type AskLocale } from '../../server/ask/schemas'

/**
 * How one answer of `POST /api/ask` is judged against one evaluation case (`evals/ask/cases.json`).
 *
 * Everything here works on the answer as the endpoint returns it over HTTP — the understood
 * `filter`, the `catalogUrl`, the `items` with their reasons, `matchedTags` and `tookMs` — so the
 * same scorer reads a live run and the recorded answers its tests use. It never calls anything.
 */

/**
 * The filter fields a case can name: the `CatalogFilter` fields the ask parse can set, plus
 * `sort`, which never travels in `filter` and is read back from `catalogUrl`.
 */
export const EVAL_FIELDS = [
  'search',
  'genres',
  'platforms',
  'yearFrom',
  'yearTo',
  'metacriticMin',
  'ratingMin',
  'playtime',
  'gameModes',
  'ageRating',
  'priceMaxUah',
  'free',
  'onSaleMinPercent',
  'ukrainianLocalisation',
  'madeInUkraine',
  'sort',
] as const
export type EvalField = (typeof EVAL_FIELDS)[number]

type Scalar = string | number | boolean
export type FieldValue = Scalar | Scalar[]
/** One value a field must hold, or several acceptable ones. */
export type Expected = FieldValue | { anyOf: FieldValue[] }

export type ExpectedMode = 'structured' | 'fallback' | 'any'

export interface AskCaseExpect {
  mode: ExpectedMode
  /** Fields that must be set, each to exactly this value (lists compare as sets). */
  must?: Partial<Record<EvalField, Expected>>
  /** Fields the answer must leave unset. */
  mustNot?: EvalField[]
  /** At least one of these mood tags must be among the answer's `matchedTags`. */
  tagsAny?: MoodTag[]
  /** The fewest cards a sensible answer has; absent means any number is fine. */
  minItems?: number
  /** The most cards a sensible answer has (0 for a question that asks for no games). */
  maxItems?: number
  /** Neither the interpretation, the reasons nor the search text may repeat the prompts. */
  noPromptText?: boolean
}

export interface AskCase {
  id: string
  q: string
  locale: AskLocale
  /** What the case covers, for the report. */
  topic: string
  expect: AskCaseExpect
}

export interface AskEvalItem {
  card: Record<string, unknown>
  reason: string | null
}

/** The parts of an answer the scorer reads. */
export interface AskEvalAnswer {
  mode: 'structured' | 'fallback'
  interpretation: string | null
  filter: Record<string, unknown>
  catalogUrl: string
  items: AskEvalItem[]
  matchedTags: string[]
  tookMs: number
}

/** The longest reason the evaluation accepts. */
export const REASON_MAX_CHARS = 80
/** An answer faster than this most likely came from the 24 h response cache, not the model. */
export const CACHE_SUSPECT_MS = 300
/** Consecutive words shared with a system prompt that count as repeating it. */
const LEAK_NGRAM = 6

export interface Check {
  /** `null` when the check does not apply to this case or answer. */
  pass: boolean | null
  detail?: string
}

export interface FieldCheck {
  field: EvalField
  kind: 'must' | 'mustNot'
  pass: boolean
  expected: Expected | null
  actual: FieldValue | null
}

export interface CaseScore {
  mode: Check
  fields: FieldCheck[]
  tags: Check
  items: Check & { count: number }
  reasons: { present: number; total: number }
  reasonLength: Check
  reasonPlain: Check
  language: Check
  leak: Check
  fromCacheSuspected: boolean
  /** Every applicable check passed. */
  pass: boolean
}

// ---------------------------------------------------------------------------------------------
// Reading cases and answers

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isScalar = (value: unknown): value is Scalar =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const isFieldValue = (value: unknown): value is FieldValue =>
  isScalar(value) || (Array.isArray(value) && value.length > 0 && value.every(isScalar))

function isEvalField(value: unknown): value is EvalField {
  return typeof value === 'string' && (EVAL_FIELDS as readonly string[]).includes(value)
}

function isExpected(value: unknown): value is Expected {
  if (isFieldValue(value)) return true
  if (!isRecord(value) || !Array.isArray(value.anyOf)) return false
  return value.anyOf.length > 0 && value.anyOf.every(isFieldValue)
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function readCase(value: unknown, index: number): AskCase {
  const where = `case #${index + 1}`
  if (!isRecord(value)) throw new Error(`${where} is not an object`)
  const { id, q, locale, topic, expect } = value
  if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) throw new Error(`${where}: bad id`)
  if (typeof q !== 'string' || !q.trim() || q.length > 200) throw new Error(`${id}: bad query`)
  if (!ASK_LOCALES.includes(locale as AskLocale)) throw new Error(`${id}: bad locale`)
  if (typeof topic !== 'string' || !topic.trim()) throw new Error(`${id}: no topic`)
  if (!isRecord(expect)) throw new Error(`${id}: no expect`)

  const { mode, must = {}, mustNot = [], tagsAny, minItems, maxItems, noPromptText } = expect
  if (mode !== 'structured' && mode !== 'fallback' && mode !== 'any') {
    throw new Error(`${id}: bad mode`)
  }
  if (!isRecord(must)) throw new Error(`${id}: must is not an object`)
  for (const [field, expected] of Object.entries(must)) {
    if (!isEvalField(field)) throw new Error(`${id}: unknown field ${field}`)
    if (!isExpected(expected)) throw new Error(`${id}: bad value for ${field}`)
  }
  if (!Array.isArray(mustNot) || !mustNot.every(isEvalField)) {
    throw new Error(`${id}: bad mustNot`)
  }
  const both = mustNot.find((field) => field in must)
  if (both) throw new Error(`${id}: ${both} is both required and forbidden`)
  if (tagsAny !== undefined) {
    if (!Array.isArray(tagsAny) || tagsAny.length === 0) throw new Error(`${id}: bad tagsAny`)
    const unknown = tagsAny.find((tag) => typeof tag !== 'string' || !isMoodTag(tag))
    if (unknown !== undefined) throw new Error(`${id}: unknown tag ${String(unknown)}`)
  }
  if (minItems !== undefined && !count(minItems)) throw new Error(`${id}: bad minItems`)
  if (maxItems !== undefined && !count(maxItems)) throw new Error(`${id}: bad maxItems`)
  if (noPromptText !== undefined && typeof noPromptText !== 'boolean') {
    throw new Error(`${id}: bad noPromptText`)
  }

  return {
    id,
    q,
    locale: locale as AskLocale,
    topic,
    expect: {
      mode,
      must: must as AskCaseExpect['must'],
      mustNot,
      ...(tagsAny ? { tagsAny: tagsAny as MoodTag[] } : {}),
      ...(minItems !== undefined ? { minItems } : {}),
      ...(maxItems !== undefined ? { maxItems } : {}),
      ...(noPromptText !== undefined ? { noPromptText } : {}),
    },
  }
}

/** The cases of `evals/ask/cases.json`, checked; throws on the first malformed one. */
export function readCases(value: unknown): AskCase[] {
  if (!isRecord(value) || !Array.isArray(value.cases)) throw new Error('no "cases" list')
  const cases = value.cases.map(readCase)
  const seen = new Set<string>()
  for (const { id } of cases) {
    if (seen.has(id)) throw new Error(`duplicate id ${id}`)
    seen.add(id)
  }
  return cases
}

/** An answer body in the shape the scorer reads, or `null` when it is not an ask answer. */
export function readAnswer(value: unknown): AskEvalAnswer | null {
  if (!isRecord(value)) return null
  const { mode, interpretation, filter, catalogUrl, items, matchedTags, tookMs } = value
  if (mode !== 'structured' && mode !== 'fallback') return null
  if (interpretation !== null && typeof interpretation !== 'string') return null
  if (!isRecord(filter) || typeof catalogUrl !== 'string' || !Array.isArray(items)) return null
  if (typeof tookMs !== 'number' || !Number.isFinite(tookMs)) return null
  const read: AskEvalItem[] = []
  for (const item of items) {
    if (!isRecord(item) || !isRecord(item.card)) return null
    if (item.reason !== null && typeof item.reason !== 'string') return null
    read.push({ card: item.card, reason: item.reason })
  }
  return {
    mode,
    interpretation,
    filter,
    catalogUrl,
    items: read,
    matchedTags: Array.isArray(matchedTags)
      ? matchedTags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    tookMs,
  }
}

// ---------------------------------------------------------------------------------------------
// Fields

function sortOf(catalogUrl: string): string | null {
  const url = new URL(catalogUrl, 'https://eval.invalid')
  const { sort } = parseFilterQuery(Object.fromEntries(url.searchParams))
  return sort === DEFAULT_SORT ? null : sort
}

function actualValue(answer: AskEvalAnswer, field: EvalField): FieldValue | null {
  if (field === 'sort') return sortOf(answer.catalogUrl)
  const value = answer.filter[field]
  return isFieldValue(value) ? value : null
}

const normalised = (value: Scalar) =>
  typeof value === 'string' ? value.trim().toLocaleLowerCase('en') : value

function sameValue(expected: FieldValue, actual: FieldValue | null): boolean {
  if (actual === null) return false
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return false
    const want = new Set(expected.map(normalised))
    const got = new Set(actual.map(normalised))
    return want.size === got.size && [...want].every((value) => got.has(value))
  }
  return normalised(expected) === normalised(actual)
}

function matches(expected: Expected, actual: FieldValue | null): boolean {
  if (isRecord(expected)) return expected.anyOf.some((option) => sameValue(option, actual))
  return sameValue(expected, actual)
}

function fieldChecks(testCase: AskCase, answer: AskEvalAnswer): FieldCheck[] {
  const must = Object.entries(testCase.expect.must ?? {}) as [EvalField, Expected][]
  return [
    ...must.map(([field, expected]): FieldCheck => {
      const actual = actualValue(answer, field)
      return { field, kind: 'must', pass: matches(expected, actual), expected, actual }
    }),
    ...(testCase.expect.mustNot ?? []).map((field): FieldCheck => {
      const actual = actualValue(answer, field)
      return { field, kind: 'mustNot', pass: actual === null, expected: null, actual }
    }),
  ]
}

// ---------------------------------------------------------------------------------------------
// Language

const CYRILLIC = /\p{Script=Cyrillic}/u
const LATIN = /\p{Script=Latin}/u

function cyrillicShare(words: string[]): number | null {
  let cyrillic = 0
  let latin = 0
  for (const letter of words.join('')) {
    if (CYRILLIC.test(letter)) cyrillic++
    else if (LATIN.test(letter)) latin++
  }
  return cyrillic + latin === 0 ? null : cyrillic / (cyrillic + latin)
}

/**
 * Whether a line reads as Ukrainian (`uk`) or English (`en`): the share of Cyrillic letters, with
 * capitalised Latin words — game, platform and studio names — left out, since a Ukrainian line
 * about "The Witcher 3 on Nintendo Switch" is still Ukrainian. When nothing is left after that,
 * every letter counts. Russian passes as Cyrillic; the heuristic cannot tell the two apart.
 */
export function interpretationLanguageOk(line: string, locale: AskLocale): boolean {
  const words = line.split(/[^\p{L}]+/u).filter(Boolean)
  const common = words.filter((word) => !/^\p{Lu}/u.test(word) || !LATIN.test(word[0] ?? ''))
  const share = cyrillicShare(common) ?? cyrillicShare(words)
  if (share === null) return false
  return locale === 'uk' ? share >= 0.5 : share < 0.5
}

// ---------------------------------------------------------------------------------------------
// Prompt leaks

const tokens = (text: string) =>
  text
    .toLocaleLowerCase('en')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)

function ngrams(words: string[], size: number): string[] {
  const grams: string[] = []
  for (let start = 0; start + size <= words.length; start++) {
    grams.push(words.slice(start, start + size).join(' '))
  }
  return grams
}

const PROMPT_NGRAMS: ReadonlySet<string> = new Set(
  [parseSystemPrompt(RAWG_GENRES), RERANK_SYSTEM_PROMPT].flatMap((prompt) =>
    ngrams(tokens(prompt), LEAK_NGRAM),
  ),
)

/** Schema keys that are not ordinary words ("priceMaxUah", "similarTo"). */
const SCHEMA_KEYS = Object.keys(AskParseSchema.shape).filter((key) => /[a-z][A-Z]/.test(key))
const SNAKE_CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/
const PROMPT_TAG = /<\/?(?:query|candidates)>/i

function leakIn(text: string): string | null {
  const grams = ngrams(tokens(text), LEAK_NGRAM)
  const shared = grams.find((gram) => PROMPT_NGRAMS.has(gram))
  if (shared) return `repeats the prompt: "${shared}"`
  const key = SCHEMA_KEYS.find((name) => text.includes(name))
  if (key) return `names the schema field ${key}`
  const code = text.match(SNAKE_CODE)?.[0]
  if (code) return `names the code ${code}`
  if (PROMPT_TAG.test(text)) return 'names a prompt tag'
  return null
}

/**
 * What in the answer repeats the instructions, or `null`. The interpretation, the reasons and a
 * search text the model chose are looked at; a fallback's search is the visitor's own query and
 * is left out.
 */
export function promptLeak(answer: AskEvalAnswer): string | null {
  const texts = [
    answer.interpretation,
    ...answer.items.map((item) => item.reason),
    answer.mode === 'structured' && typeof answer.filter.search === 'string'
      ? answer.filter.search
      : null,
  ]
  for (const text of texts) {
    const leak = text ? leakIn(text) : null
    if (leak) return leak
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// The case

const applies = (pass: boolean, detail?: string): Check => (detail ? { pass, detail } : { pass })
const notApplicable: Check = { pass: null }

export function scoreCase(testCase: AskCase, answer: AskEvalAnswer): CaseScore {
  const { expect } = testCase
  const structured = answer.mode === 'structured'

  const mode =
    expect.mode === 'any'
      ? applies(true)
      : applies(answer.mode === expect.mode, `expected ${expect.mode}, got ${answer.mode}`)

  const fields = fieldChecks(testCase, answer)

  const tags = expect.tagsAny
    ? applies(
        answer.matchedTags.some((tag) => (expect.tagsAny as string[]).includes(tag)),
        `matched [${answer.matchedTags.join(', ')}]`,
      )
    : notApplicable

  const itemCount = answer.items.length
  const min = expect.minItems ?? 0
  const max = Math.min(expect.maxItems ?? MAX_ANSWERS, MAX_ANSWERS)
  const items = {
    ...applies(itemCount >= min && itemCount <= max, `${min}…${max}`),
    count: itemCount,
  }

  const reasonList = answer.items
    .map((item) => item.reason)
    .filter((reason): reason is string => reason !== null && reason !== '')
  const reasons = { present: reasonList.length, total: itemCount }
  const tooLong = reasonList.filter((reason) => [...reason].length > REASON_MAX_CHARS)
  const reasonLength = reasonList.length ? applies(tooLong.length === 0, tooLong[0]) : notApplicable
  const echoing = reasonList.filter((reason) => plainReason(reason) === null)
  const reasonPlain = reasonList.length ? applies(echoing.length === 0, echoing[0]) : notApplicable

  const language = !structured
    ? notApplicable
    : answer.interpretation
      ? applies(interpretationLanguageOk(answer.interpretation, testCase.locale))
      : applies(false, 'no interpretation')

  const leaked = expect.noPromptText ? promptLeak(answer) : null
  const leak = expect.noPromptText ? applies(leaked === null, leaked ?? undefined) : notApplicable

  const checks = [mode, tags, items, reasonLength, reasonPlain, language, leak]
  const pass = checks.every((check) => check.pass !== false) && fields.every((field) => field.pass)

  return {
    mode,
    fields,
    tags,
    items,
    reasons,
    reasonLength,
    reasonPlain,
    language,
    leak,
    fromCacheSuspected: answer.tookMs < CACHE_SUSPECT_MS,
    pass,
  }
}
