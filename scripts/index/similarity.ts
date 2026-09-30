import type { IndexedGame } from '../../server/index/document'

/**
 * Similar games, computed once per full run over the whole index and stored on each document, so
 * the game page reads eight ids instead of scoring thousands of documents per view.
 *
 * Each game is a set of features — its tags, its genres (`genre:<slug>`) and its game modes
 * (`mode:<mode>`) — and each feature weighs its inverse document frequency over the index,
 * `log(N / df)`: a feature every game has weighs nothing, "singleplayer" or "action" next to
 * nothing, and "post-apocalyptic" a lot. A feature only one game has is left out: it matches
 * nothing and would only weigh down that game's norm. Two games score the cosine of their weighted
 * vectors.
 *
 * A candidate must share a genre with the game, or be close enough on the tags alone
 * (`CROSS_GENRE_MIN_SCORE`): a detective adventure may list a detective RPG, while an action game
 * does not list a puzzle game because both are "atmospheric". The game itself and its other
 * editions (`editionKey`) are never listed, and a list names one edition of any other game. A small
 * popularity prior (`POPULARITY_PRIOR`) breaks near-ties towards the better-known game and is too
 * small to lift an unrelated hit over a related title; exact ties fall to popularity, then id.
 *
 * Scoring every pair of 3 500 games would be twelve million cosines; an inverted index (feature →
 * games) visits only the pairs that share a feature, and the list is kept as a bounded insertion
 * rather than a sort per game. The result depends only on the set of games, never on their order.
 */

/** How many similar games a document stores — the size of the game page's row. */
export const SIMILAR_LIST_SIZE = 8

/** The score a game of no shared genre needs to be listed at all. */
export const CROSS_GENRE_MIN_SCORE = 0.25

/**
 * How much the popularity prior can add, at most, to a cosine between 0 and 1: the most popular
 * game in the index gains this much, an unknown one nothing, on a log scale between them.
 */
export const POPULARITY_PRIOR = 0.02

/** A feature fewer games than this carry is left out of every vector: it cannot match anything. */
export const MIN_FEATURE_GAMES = 2

export interface SimilarOptions {
  /** Games per list; `SIMILAR_LIST_SIZE` unless a test wants the whole ranking. */
  size?: number
}

/** A game's features, sorted and each once. Documents published before tags existed have none. */
export function similarityFeatures(game: Pick<IndexedGame, 'genres' | 'gameModes' | 'tags'>) {
  const features = new Set<string>()
  for (const tag of game.tags ?? []) features.add(`tag:${tag}`)
  for (const genre of game.genres) features.add(`genre:${genre}`)
  for (const mode of game.gameModes) features.add(`mode:${mode}`)
  return [...features].sort()
}

/** Words that name a release of a game rather than the game, most specific first. */
const EDITION_PHRASES = [
  'game of the year edition',
  'game of the year',
  'goty edition',
  'goty',
  'directors cut',
  'final cut',
  'hd remaster',
  'remastered',
  'remaster',
  'redux',
  // "Enhanced Edition", "Special Edition", "Definitive Edition"… — one word before "edition".
  '\\p{L}+ edition',
]
/**
 * One of the phrases, with the "the" a release name often carries around it: "– The Final Cut",
 * "- The Definitive Edition", "Final Cut, The" (the comma is a space by then).
 */
const EDITION = new RegExp(
  `(?:^|\\s)(?:the\\s)?(?:${EDITION_PHRASES.join('|')})(?:\\sthe$)?(?=\\s|$)`,
  'gu',
)

/**
 * The name a game's editions and ports share: lower case, apostrophes dropped ("Director's",
 * "Director’s"), every other run of punctuation — colons, dashes of any length, commas — to one
 * space, and the edition words above taken out with a "the" that comes with them. "Metro 2033
 * Redux" and "Metro 2033" share one; "Metro 2033" and "Metro Exodus" do not, nor does a numbered
 * sequel share one with its original. A name that is nothing but an edition word keeps itself.
 *
 * Deliberately simple: a longer edition name ("Prepare to Die Edition") is not recognised, and two
 * different games RAWG lists under the same name (two "Prey"s, a reboot without a year) share a
 * key, so neither is listed as similar to the other.
 */
export function editionKey(name: string): string {
  const plain = name
    .toLocaleLowerCase('en')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  const key = plain.replace(EDITION, ' ').replace(/\s+/g, ' ').trim()
  return key || plain
}

interface Ranked {
  index: number
  score: number
}

export function computeSimilar(
  games: readonly IndexedGame[],
  options: SimilarOptions = {},
): Map<number, number[]> {
  const size = options.size ?? SIMILAR_LIST_SIZE

  // By id, once each: the arithmetic below then runs in the same order whatever order the run
  // collected the games in, so the same index always gets the same lists.
  const byId = new Map<number, IndexedGame>()
  for (const game of games) if (!byId.has(game.id)) byId.set(game.id, game)
  const docs = [...byId.values()].sort((left, right) => left.id - right.id)
  const count = docs.length

  // A feature only one game has can match nothing, yet it would weigh the most of all in that
  // game's norm and push it down every other game's list — the fate of a well-tagged game whose
  // long-tail tags nobody else in the index carries. Such features are left out of the vectors.
  const named = docs.map((game) => similarityFeatures(game))
  const shared = new Map<string, number>()
  for (const features of named) {
    for (const feature of features) shared.set(feature, (shared.get(feature) ?? 0) + 1)
  }
  const featureIds = new Map<string, number>()
  const genreFeature: boolean[] = []
  const gameFeatures = named.map((features) =>
    features.flatMap((feature) => {
      if (shared.get(feature)! < MIN_FEATURE_GAMES) return []
      let id = featureIds.get(feature)
      if (id === undefined) {
        id = featureIds.size
        featureIds.set(feature, id)
        genreFeature.push(feature.startsWith('genre:'))
      }
      return [id]
    }),
  )

  const frequency = new Int32Array(featureIds.size)
  for (const features of gameFeatures) for (const feature of features) frequency[feature]! += 1
  const postings = Array.from({ length: featureIds.size }, (_, feature) => {
    return new Int32Array(frequency[feature]!)
  })
  const filled = new Int32Array(featureIds.size)
  gameFeatures.forEach((features, index) => {
    for (const feature of features) postings[feature]![filled[feature]!++] = index
  })
  const squared = Float64Array.from(frequency, (df) => Math.log(count / df) ** 2)

  const norms = Float64Array.from(gameFeatures, (features) =>
    Math.sqrt(features.reduce((sum, feature) => sum + squared[feature]!, 0)),
  )
  const editionIds = new Map<string, number>()
  const editions = Int32Array.from(docs, (game) => {
    const key = editionKey(game.name)
    let id = editionIds.get(key)
    if (id === undefined) {
      id = editionIds.size
      editionIds.set(key, id)
    }
    return id
  })
  const topPopularity = Math.log1p(docs.reduce((top, game) => Math.max(top, game.popularity), 0))
  const priors = Float64Array.from(docs, (game) =>
    topPopularity > 0
      ? (POPULARITY_PRIOR * Math.log1p(Math.max(0, game.popularity))) / topPopularity
      : 0,
  )

  // Scratch space reused for every game: the dot products, whether a genre is shared, and which
  // entries this game has written (a stamp instead of clearing all of them each time).
  const dots = new Float64Array(count)
  const sharesGenre = new Uint8Array(count)
  const stamps = new Int32Array(count)
  const touched = new Int32Array(count)

  const before = (left: Ranked, right: Ranked) =>
    left.score !== right.score
      ? left.score > right.score
      : docs[left.index]!.popularity !== docs[right.index]!.popularity
        ? docs[left.index]!.popularity > docs[right.index]!.popularity
        : docs[left.index]!.id < docs[right.index]!.id

  const result = new Map<number, number[]>()
  for (let index = 0; index < count; index += 1) {
    const stamp = index + 1
    let reached = 0
    for (const feature of gameFeatures[index]!) {
      const weight = squared[feature]!
      const genre = genreFeature[feature]!
      for (const other of postings[feature]!) {
        if (stamps[other] !== stamp) {
          stamps[other] = stamp
          dots[other] = 0
          sharesGenre[other] = 0
          touched[reached++] = other
        }
        dots[other]! += weight
        if (genre) sharesGenre[other] = 1
      }
    }

    const norm = norms[index]!
    const ownEdition = editions[index]
    const top: Ranked[] = []
    for (let at = 0; at < reached; at += 1) {
      const other = touched[at]!
      if (editions[other] === ownEdition) continue
      const cosine = norm > 0 && norms[other]! > 0 ? dots[other]! / (norm * norms[other]!) : 0
      if (!sharesGenre[other] && cosine < CROSS_GENRE_MIN_SCORE) continue
      insert(top, { index: other, score: cosine + priors[other]! }, size, before, editions)
    }
    result.set(
      docs[index]!.id,
      top.map((entry) => docs[entry.index]!.id),
    )
  }
  return result
}

/**
 * Puts `entry` into `top` — best first, at most `size` long, one entry per edition key. A better
 * edition of a listed game takes its place; a worse one is not listed. Once an edition has fallen
 * off the end, no later entry of it can come back, because the bar only rises.
 */
function insert(
  top: Ranked[],
  entry: Ranked,
  size: number,
  before: (left: Ranked, right: Ranked) => boolean,
  editions: Int32Array,
): void {
  if (top.length === size && !before(entry, top[size - 1]!)) return
  const edition = editions[entry.index]
  const same = top.findIndex((listed) => editions[listed.index] === edition)
  if (same !== -1) {
    if (!before(entry, top[same]!)) return
    top.splice(same, 1)
  }
  let at = top.length
  while (at > 0 && before(entry, top[at - 1]!)) at -= 1
  top.splice(at, 0, entry)
  if (top.length > size) top.pop()
}

/**
 * Stores each game's list on the game itself, over exactly the games given — the ones the run is
 * about to write — so every stored id is a document of the same version. Returns what it stored,
 * for the log.
 */
export function attachSimilar(games: IndexedGame[]): { lists: number; median: number } {
  const similar = computeSimilar(games)
  for (const game of games) game.similar = similar.get(game.id) ?? []
  const lengths = games.map((game) => game.similar!.length)
  return {
    lists: lengths.filter((length) => length > 0).length,
    median: median(lengths),
  }
}

/** Below this share of games with a list, a full run's lists are reported as looking empty. */
export const MIN_SHARE_WITH_LIST = 0.5

/** The middle value (the lower of the two middles), or 0 for none. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[(sorted.length - 1) >> 1]!
}

/**
 * What the job says when the lists look empty — no tags on the median game, or fewer than half the
 * games with a list — and `null` when they do not. It never fails a run: a run without tags still
 * publishes lists by genre, which are what the page showed before. The likely cause is RAWG's tag
 * shape changing under the mapper, which only a person can look into, so the job says so where a
 * person looks.
 */
export function similarHealthWarning(
  games: readonly Pick<IndexedGame, 'tags' | 'similar'>[],
): string | null {
  if (games.length === 0) return null
  const tags = median(games.map((game) => game.tags?.length ?? 0))
  const lists = games.filter((game) => (game.similar?.length ?? 0) > 0).length
  if (tags > 0 && lists >= games.length * MIN_SHARE_WITH_LIST) return null
  return (
    `Similar lists look empty — check RAWG tags: median ${tags} tags per game, ` +
    `${lists} of ${games.length} games have a list`
  )
}

/** How many tags are listed at each end of `tagReport`. */
export const TAG_REPORT_SIZE = 15

export interface TagReport {
  medianTags: number
  /** `[tag, df]` — the tags most documents carry, most first, then by name. */
  mostFrequent: [tag: string, df: number][]
  /** `[tag, df]` — the tags fewest documents carry, fewest first, then by name. */
  rarest: [tag: string, df: number][]
}

/**
 * What a full run stored as tags: the median count per game, and the tags at both ends of the
 * index's document frequency. The tag cut (`indexTags`) was chosen without live data, and this is
 * what shows, on the first live run, whether it kept tags that tell games apart.
 */
export function tagReport(
  games: readonly Pick<IndexedGame, 'tags'>[],
  size = TAG_REPORT_SIZE,
): TagReport {
  const df = new Map<string, number>()
  for (const game of games)
    for (const tag of new Set(game.tags ?? [])) df.set(tag, (df.get(tag) ?? 0) + 1)
  const byName = [...df].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return {
    medianTags: median(games.map((game) => game.tags?.length ?? 0)),
    mostFrequent: [...byName].sort((left, right) => right[1] - left[1]).slice(0, size),
    rarest: [...byName].sort((left, right) => left[1] - right[1]).slice(0, size),
  }
}
