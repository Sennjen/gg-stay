import { fetchCandidatePage, type RawgGamesPage } from './candidates'
import type { JobIndex, JobLog } from './deps'
import { microsoftProductUrl } from './microsoft'
import type { RequestMeter } from './requestMeter'
import { usableFallbacks } from './storeFallbacks'
import { usableStoreRefs } from './storeRefs'
import {
  offerWay,
  type IndexedGame,
  type IndexedOffer,
  type IndexedStoreRefs,
  type OfferStore,
} from '../../server/index/document'
import type { RawgFetch } from '../../server/rawg/rawgFetch'

/**
 * `--mode=export`: a table of every game the job knows, with its store links and prices, written
 * to a CSV file for whoever cannot read the index itself. Run by hand; it publishes nothing and
 * writes nothing to the index.
 *
 * **Which games.** Every document of the published version, and every game a resolve run learned
 * the store pages of: it has an `appid:` entry or a `storeref:` record and no document. Nothing
 * lists those, so they are found the way they were met: by reading RAWG's most-added order from
 * page 1 (`fetchCandidatePage`, the very query of the nightly run and of resolve), and looking up
 * every game on the pages that has no document.
 *
 * **What it costs RAWG.** Only those pages, inside a budget counted where the requests leave
 * (`requestMeter.ts`), retries included: the limit is set on the transport before the first page,
 * and the reading stops, and says so, when it is spent. No game's store links are asked for, and
 * no store is asked anything: what the table says is what the index holds.
 *
 * **Read only.** The stage is handed the four reads it needs (`ExportIndex`) and nothing else, so
 * it can run on the index's read-only token and takes no writer lock.
 *
 * Nothing RAWG wrote reaches the log or the summary: they carry counts, and the names, slugs and
 * links go into the file alone.
 */

/** The most RAWG requests one export may be given. */
export const EXPORT_MAX_BUDGET = 400

/** The pages read when no number is given: as far down as the resolve runs have gone. */
export const EXPORT_DEFAULT_PAGES = 221

/** What the file is called, in the directory the run is given. */
export const EXPORT_FILE_NAME = 'games.csv'

/** How many games one read of a mapping asks about. */
const MAPPING_CHUNK = 500

/** The four reads the stage needs. It is handed nothing that writes. */
export type ExportIndex = Pick<JobIndex, 'allGames' | 'meta' | 'getAppIds' | 'getStoreRefs'>

export interface ExportDeps {
  rawg: RawgFetch
  rawgRequests: RequestMeter
  index: ExportIndex
  log: JobLog
}

export interface ExportOptions {
  /** The most RAWG requests the run may send, retries included. */
  budget: number
  /** The most pages of the most-added order to read, from page 1. */
  pages: number
}

/** The file's columns, in order. One row a game. */
export const EXPORT_COLUMNS = [
  'rawg_id',
  'name',
  'slug',
  'released',
  'on_site',
  'steam_url',
  'steam_price_uah',
  'gog_url',
  'gog_price_usd',
  'gog_price_uah_approx',
  'gog_via',
  'xbox_url',
  'xbox_price_uah',
  'xbox_via',
  'playstation_url',
  'playstation_price_uah',
  'playstation_via',
] as const

export type ExportColumn = (typeof EXPORT_COLUMNS)[number]
export type ExportRow = Record<ExportColumn, string>

/** The stores the table has columns for, by the prefix of those columns. */
export const EXPORT_STORES = ['steam', 'gog', 'xbox', 'playstation'] as const
export type ExportStore = (typeof EXPORT_STORES)[number]

/** For each store: the games with a link, and those with a price. */
export type ExportStoreTotals = Record<ExportStore, { links: number; prices: number }>

/** Why the reading of pages ended. */
export type ExportReadingEnd =
  /** Every page it was given was read. */
  | 'pages'
  /** RAWG's list has no page after the last one read. */
  | 'list-end'
  /** RAWG failed a page, after the transport's retry. */
  | 'page-failed'
  /** The budget was spent. */
  | 'budget'

export interface ExportReport {
  budget: number
  pages: number
  pagesRead: number
  /** The page RAWG failed, when that ended the reading. */
  failedPage: number | null
  readingEnded: ExportReadingEnd
  /** RAWG requests sent, retries included, as the transport's meter counted them. */
  requests: number
  /** Rows of the file: games with a document, and games a resolve run learned. */
  games: { onSite: number; notOnSite: number }
  stores: { onSite: ExportStoreTotals; notOnSite: ExportStoreTotals }
}

export interface ExportResult {
  rows: ExportRow[]
  report: ExportReport
}

/**
 * Refuses a run it cannot keep inside a budget: no budget, one that is not a positive whole
 * number, one above `EXPORT_MAX_BUDGET`, or a page count that is not a positive whole number.
 */
export function assertExportOptions(options: {
  budget?: number
  pages?: number
}): asserts options is ExportOptions {
  const { budget, pages } = options
  if (budget === undefined) {
    throw new Error(
      '--mode=export needs a budget: the most RAWG requests the run may send ' +
        `(--budget=N, at most ${EXPORT_MAX_BUDGET}).`,
    )
  }
  if (!Number.isSafeInteger(budget) || budget < 1) {
    throw new Error(`--budget must be a positive whole number, got ${budget}.`)
  }
  if (budget > EXPORT_MAX_BUDGET) {
    throw new Error(
      `--budget=${budget} is above the most an export may be given (${EXPORT_MAX_BUDGET}).`,
    )
  }
  if (pages === undefined || !Number.isSafeInteger(pages) || pages < 1) {
    throw new Error(`--pages must be a positive whole number, got ${pages}.`)
  }
}

/** A game met on a page of the order that has no document. */
interface Listed {
  id: number
  name: string
  slug: string
  released: string
}

/** Minor units as a decimal amount: `59999` is `599.99`. */
function minor(amount: number): string {
  return (amount / 100).toFixed(2)
}

/** The GOG game page a slug names. */
export function gogGameUrl(slug: string): string {
  return `https://www.gog.com/en/game/${slug}`
}

/** RAWG's link to the game on the PlayStation Store, from the links the record keeps. */
function playstationLink(record: IndexedStoreRefs | undefined): string {
  for (const entry of Array.isArray(record?.links) ? record.links : []) {
    if (!Array.isArray(entry) || entry[0] !== 3 || typeof entry[1] !== 'string') continue
    try {
      const url = new URL(entry[1])
      if (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.hostname === 'store.playstation.com'
      ) {
        return url.href
      }
    } catch {
      // Not a URL: not a link.
    }
  }
  return ''
}

function offerOf(game: IndexedGame | undefined, store: OfferStore): IndexedOffer | undefined {
  return game?.offers?.find((offer) => offer.store === store)
}

/** The store columns of one game. */
function storeCells(
  game: IndexedGame | undefined,
  appId: string | undefined,
  record: IndexedStoreRefs | undefined,
  rate: number | null,
): Omit<ExportRow, 'rawg_id' | 'name' | 'slug' | 'released' | 'on_site'> {
  const refs = usableStoreRefs(record)
  const fallbacks = usableFallbacks(record)

  const steamId = game?.steamAppId ?? appId ?? ''
  const steamUrl = /^\d+$/.test(steamId) ? `https://store.steampowered.com/app/${steamId}/` : ''
  const steamPrice = steamUrl && game ? (game.priceUah ?? (game.free ? 0 : null)) : null

  const gog = offerOf(game, 'gog')
  const gogSlug = refs.gog ?? fallbacks.gog?.slug
  const gogUsd = gog?.currency === 'USD' ? gog.amount : null

  const xbox = offerOf(game, 'xbox-store')
  const product = refs.microsoft ?? fallbacks.microsoft.found

  const playstation = offerOf(game, 'playstation-store')

  return {
    steam_url: steamUrl,
    steam_price_uah: steamPrice === null ? '' : String(steamPrice),
    gog_url: gog?.url ?? (gogSlug ? gogGameUrl(gogSlug) : ''),
    gog_price_usd: gogUsd === null ? '' : minor(gogUsd),
    gog_price_uah_approx:
      gogUsd === null || rate === null ? '' : String(Math.round((gogUsd / 100) * rate)),
    gog_via: gog ? offerWay(gog) : '',
    xbox_url:
      xbox?.url ?? (product ? microsoftProductUrl({ id: product.id, name: product.name }) : ''),
    xbox_price_uah: xbox?.currency === 'UAH' ? minor(xbox.amount) : '',
    xbox_via: xbox ? offerWay(xbox) : '',
    playstation_url: playstation?.url ?? playstationLink(record),
    playstation_price_uah: playstation?.currency === 'UAH' ? minor(playstation.amount) : '',
    playstation_via: playstation ? offerWay(playstation) : '',
  }
}

/** The link and the price column of each store: a cell that is not empty is one of either. */
const STORE_COLUMNS: Record<ExportStore, { link: ExportColumn; price: ExportColumn }> = {
  steam: { link: 'steam_url', price: 'steam_price_uah' },
  gog: { link: 'gog_url', price: 'gog_price_usd' },
  xbox: { link: 'xbox_url', price: 'xbox_price_uah' },
  playstation: { link: 'playstation_url', price: 'playstation_price_uah' },
}

/** The totals of the summary, per store, split by whether the game is on the site. */
export function exportTotals(rows: readonly ExportRow[]): ExportReport['stores'] {
  const empty = (): ExportStoreTotals => ({
    steam: { links: 0, prices: 0 },
    gog: { links: 0, prices: 0 },
    xbox: { links: 0, prices: 0 },
    playstation: { links: 0, prices: 0 },
  })
  const totals = { onSite: empty(), notOnSite: empty() }
  for (const row of rows) {
    const side = row.on_site === 'yes' ? totals.onSite : totals.notOnSite
    for (const store of EXPORT_STORES) {
      if (row[STORE_COLUMNS[store].link] !== '') side[store].links += 1
      if (row[STORE_COLUMNS[store].price] !== '') side[store].prices += 1
    }
  }
  return totals
}

/** Reads one mapping for many games, a chunk a request. */
async function readChunked<T>(
  ids: readonly number[],
  read: (ids: number[]) => Promise<Map<number, T>>,
): Promise<Map<number, T>> {
  const found = new Map<number, T>()
  for (let start = 0; start < ids.length; start += MAPPING_CHUNK) {
    for (const [id, value] of await read(ids.slice(start, start + MAPPING_CHUNK))) {
      found.set(id, value)
    }
  }
  return found
}

export async function exportGames(deps: ExportDeps, options: ExportOptions): Promise<ExportResult> {
  assertExportOptions(options)
  const { budget, pages } = options
  const meter = deps.rawgRequests
  // Before anything is asked: from here the transport itself sends `budget` requests and no more.
  meter.limitTo(budget)
  const issuedBefore = meter.issued()

  const documents = await deps.index.allGames()
  const rate = (await deps.index.meta())?.exchangeRate?.uah ?? null
  const onSite = new Set(documents.map((game) => game.id))

  /** Games of the pages with no document, in the order met. */
  const listed: Listed[] = []
  const seen = new Set<number>()
  let pagesRead = 0
  let failedPage: number | null = null
  let readingEnded: ExportReadingEnd = 'pages'

  for (let page = 1; page <= pages; page += 1) {
    if (meter.remaining() === 0) {
      readingEnded = 'budget'
      break
    }
    const refusedBefore = meter.refused()
    let response: RawgGamesPage
    try {
      response = await fetchCandidatePage(deps, page)
    } catch {
      if (meter.refused() > refusedBefore) readingEnded = 'budget'
      else {
        readingEnded = 'page-failed'
        failedPage = page
      }
      break
    }
    pagesRead += 1
    for (const raw of response.results) {
      const id = raw?.id
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) continue
      if (typeof raw.slug !== 'string' || raw.slug === '') continue
      if (onSite.has(id) || seen.has(id)) continue
      seen.add(id)
      listed.push({
        id,
        slug: raw.slug,
        name: typeof raw.name === 'string' ? raw.name : '',
        released: typeof raw.released === 'string' ? raw.released : '',
      })
    }
    if (!response.next) {
      readingEnded = page < pages ? 'list-end' : 'pages'
      break
    }
  }

  const ids = [...documents.map((game) => game.id), ...listed.map((game) => game.id)]
  const appIds = await readChunked(ids, (part) => deps.index.getAppIds(part))
  const records = await readChunked(ids, (part) => deps.index.getStoreRefs(part))

  const rows: ExportRow[] = [
    ...documents.map((game): ExportRow => ({
      rawg_id: String(game.id),
      name: game.name,
      slug: game.slug,
      released: game.released ?? '',
      on_site: 'yes',
      ...storeCells(game, appIds.get(game.id), records.get(game.id), rate),
    })),
    ...listed
      // Learned by a resolve run: it left an app id, a record, or both.
      .filter((game) => appIds.has(game.id) || records.has(game.id))
      .map((game): ExportRow => ({
        rawg_id: String(game.id),
        name: game.name,
        slug: game.slug,
        released: game.released,
        on_site: 'no',
        ...storeCells(undefined, appIds.get(game.id), records.get(game.id), rate),
      })),
  ]

  const report: ExportReport = {
    budget,
    pages,
    pagesRead,
    failedPage,
    readingEnded,
    requests: meter.issued() - issuedBefore,
    games: { onSite: documents.length, notOnSite: rows.length - documents.length },
    stores: exportTotals(rows),
  }
  deps.log(
    `export: ${report.games.onSite} games on the site, ${report.games.notOnSite} learned by resolve; ` +
      `${pagesRead} of at most ${pages} pages read; ${report.requests} of ${budget} RAWG requests sent`,
  )
  if (readingEnded === 'budget') {
    deps.log(
      `::warning::Export: the budget of ${budget} RAWG requests was spent after ${pagesRead} of ` +
        `${pages} pages; games learned by resolve further down are not in the file`,
    )
  }
  if (readingEnded === 'page-failed') {
    deps.log(
      `::warning::Export: RAWG failed page ${failedPage}, so the reading ended there; games ` +
        'learned by resolve further down are not in the file',
    )
  }
  return { rows, report }
}

/**
 * A cell as a spreadsheet will take it: quoted when it holds a comma, a quote or a line break, and
 * with a leading apostrophe when it begins like a formula — the names are RAWG's text, and a
 * spreadsheet would run `=…` rather than show it.
 */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

/** What tells a spreadsheet that a CSV file is UTF-8. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff)

/**
 * The rows as UTF-8 CSV with a header, lines ended by CRLF, and a byte-order mark in front so that
 * a spreadsheet reads the names as UTF-8.
 */
export function toCsv(rows: readonly ExportRow[]): string {
  const lines = [
    EXPORT_COLUMNS.join(','),
    ...rows.map((row) => EXPORT_COLUMNS.map((column) => csvCell(row[column])).join(',')),
  ]
  return `${BYTE_ORDER_MARK}${lines.join('\r\n')}\r\n`
}
