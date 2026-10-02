import * as z from 'zod'
import {
  AGE_RATINGS,
  GAME_MODES,
  LOCALISATIONS,
  PLATFORM_FAMILIES,
  PLAYTIMES,
  UI_SORTS,
} from '../../shared/catalog'

/**
 * The two shapes a model answers `/api/ask` with, twice over.
 *
 * `AskParseSchema` and `AskRerankSchema` are what the model is constrained to: they go to the API
 * as `output_config.format`, so every enum is spelled out and every field is required — "not
 * mentioned" is `null` or an empty list, never a missing key, which keeps the shape identical for
 * every provider that can follow a JSON schema. Nothing here carries a numeric range or a length
 * limit: the SDK cannot send those to the model, and it validates the answer against this schema
 * afterwards, so a limit here would turn a price of 100 001 ₴ into a failed request instead of a
 * clamped one. The clamping is the sanitiser's job (`server/ask/sanitise.ts`).
 *
 * `readParse` and `readRerank` are the server's own second reading of whatever came back, from
 * any provider: a value it does not know is dropped rather than failing the whole answer, and the
 * result is always the full shape.
 */

/** The interface languages a query can come from; the answer's own lines follow the query. */
export const ASK_LOCALES = ['uk', 'en'] as const
export type AskLocale = (typeof ASK_LOCALES)[number]

/** The platform families a query can name. `OTHER` is not something anyone asks for. */
export const ASK_PLATFORM_FAMILIES = PLATFORM_FAMILIES.filter(
  (family): family is Exclude<(typeof PLATFORM_FAMILIES)[number], 'OTHER'> => family !== 'OTHER',
)

export const AskParseSchema = z.object({
  platforms: z.array(z.enum(ASK_PLATFORM_FAMILIES)),
  genres: z.array(z.string()),
  gameModes: z.array(z.enum(GAME_MODES)),
  ageRating: z.array(z.enum(AGE_RATINGS)),
  playtime: z.enum(PLAYTIMES).nullable(),
  yearFrom: z.number().nullable(),
  yearTo: z.number().nullable(),
  metacriticMin: z.number().nullable(),
  ratingMin: z.number().nullable(),
  priceMaxUah: z.number().nullable(),
  free: z.boolean().nullable(),
  onSaleMinPercent: z.number().nullable(),
  ukrainianLocalisation: z.enum(LOCALISATIONS).nullable(),
  madeInUkraine: z.boolean().nullable(),
  sort: z.enum(UI_SORTS).nullable(),
  searchText: z.string().nullable(),
  similarTo: z.string().nullable(),
  interpretation: z.string(),
})
export type AskParse = z.infer<typeof AskParseSchema>

export const AskRerankSchema = z.object({
  items: z.array(z.object({ id: z.string(), reason: z.string() })),
})
export type AskRerank = z.infer<typeof AskRerankSchema>

const isString = (value: unknown): value is string => typeof value === 'string'

/** A field read leniently: present or not, whatever it holds becomes a value of the full shape. */
function lenient<T>(read: (value: unknown) => T) {
  return z.unknown().optional().transform(read)
}

function enumList<T extends string>(allowed: readonly T[]) {
  return lenient((value) =>
    Array.isArray(value)
      ? value.filter((item): item is T => isString(item) && allowed.includes(item as T))
      : [],
  )
}

function enumValue<T extends string>(allowed: readonly T[]) {
  return lenient((value) => (isString(value) && allowed.includes(value as T) ? (value as T) : null))
}

const stringList = lenient((value) => (Array.isArray(value) ? value.filter(isString) : []))
const numberValue = lenient((value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null,
)
const booleanValue = lenient((value) => (typeof value === 'boolean' ? value : null))
const stringValue = lenient((value) => (isString(value) ? value : null))

const LenientParse = z.object({
  platforms: enumList(ASK_PLATFORM_FAMILIES),
  genres: stringList,
  gameModes: enumList(GAME_MODES),
  ageRating: enumList(AGE_RATINGS),
  playtime: enumValue(PLAYTIMES),
  yearFrom: numberValue,
  yearTo: numberValue,
  metacriticMin: numberValue,
  ratingMin: numberValue,
  priceMaxUah: numberValue,
  free: booleanValue,
  onSaleMinPercent: numberValue,
  ukrainianLocalisation: enumValue(LOCALISATIONS),
  madeInUkraine: booleanValue,
  sort: enumValue(UI_SORTS),
  searchText: stringValue,
  similarTo: stringValue,
  interpretation: lenient((value) => (isString(value) ? value : '')),
})

const LenientRerank = z.object({
  items: z.array(z.unknown()).transform((items) =>
    items.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return []
      const { id, reason } = item as { id?: unknown; reason?: unknown }
      const key = isString(id)
        ? id
        : typeof id === 'number' && Number.isFinite(id)
          ? String(id)
          : ''
      if (!key) return []
      return [{ id: key, reason: isString(reason) ? reason : '' }]
    }),
  ),
})

/** A parse answer in the full shape, unknown values dropped; `null` when it is not an object. */
export function readParse(value: unknown): AskParse | null {
  const result = LenientParse.safeParse(value)
  return result.success ? result.data : null
}

/** A rerank answer with its malformed items skipped; `null` when it has no item list at all. */
export function readRerank(value: unknown): AskRerank | null {
  const result = LenientRerank.safeParse(value)
  return result.success ? result.data : null
}
