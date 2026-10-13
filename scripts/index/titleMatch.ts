/**
 * Whether what a store calls a product is the game the index holds — the one judgement the
 * refresh job makes from a title, and the only place it is made.
 *
 * RAWG's link to a store is the first way to a game's product there, and for a long time it was
 * the only one: nothing was guessed from a title, because a wrong product is a wrong price under
 * the game's name. RAWG's links go stale, though, and a store that sells the game under another
 * product then has no price on the site at all. So when the link finds none, the job looks for
 * the game by the store's own means (`storeFallbacks.ts`), and what it finds there is known by
 * its title alone. Everything here is written to refuse: two titles are the same product only
 * when nothing but typography tells them apart, and an edition is the same game only when every
 * word after the game's name is a word that names an edition.
 *
 * Both stores use these functions, so a title means the same thing at GOG as it does at the
 * Microsoft Store.
 */

/** The signs a store puts in a title and a catalog leaves out of a name. */
const TRADEMARK_SIGNS = /[™®©]/g

/**
 * Every dash a title is typed with: the whole of Unicode's dash punctuation — hyphen, en dash, em
 * dash, the non-breaking and the figure dash — and the minus sign, which is filed under symbols.
 */
const DASHES = /[\p{Pd}−]/gu

/**
 * Every mark a title uses for an apostrophe: the typographic quotes, the modifier letters, the
 * prime, the grave and the acute accent standing alone.
 */
const APOSTROPHES = /[‘’‛ʹʼ′`´]/g

/**
 * A title as two titles are compared: the same string for any two that differ only in how they
 * are typed.
 *
 * - the signs ™ ® © are dropped (`Batman™: Arkham Knight` is the game's name);
 * - Unicode's compatibility forms are folded (NFKC): a non-breaking space is a space, a fullwidth
 *   letter is a letter, `Ⅱ` is `II`;
 * - case is dropped;
 * - every dash is a hyphen and every apostrophe the plain one;
 * - any run of whitespace is one space, and the ends are trimmed.
 *
 * The signs go first, and the dashes and apostrophes are read both before the folding and after
 * it. NFKC spells `™` as the two letters `TM`, and a sign that has become letters can no longer be
 * told from a word; it turns an acute accent standing alone into a space and a combining mark;
 * and it turns other characters into the very dashes and accents this is about (a fullwidth
 * grave accent into a grave accent).
 *
 * **Nothing else.** No word is dropped, no "edition" stripped, no accent removed, no distance
 * measured: `DOOM` is not `DOOM Eternal Standard Edition (PC)`, and `Batman: Arkham Knight` is not
 * `Batman - Arkham Knight`. A game that is missed costs a link without a price; a game that is
 * mistaken for another costs the site its point.
 */
export function comparableTitle(text: string): string {
  const plainMarks = (typed: string) => typed.replace(DASHES, '-').replace(APOSTROPHES, "'")
  return plainMarks(plainMarks(text.replace(TRADEMARK_SIGNS, '')).normalize('NFKC').toLowerCase())
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * The words that may follow a game's name in a store's title and leave it the same game: the
 * fixed list a title is held to once it is not the name itself (`matchTitle`).
 *
 * A store often has no product under the game's bare name. The Microsoft Store sells DOOM Eternal
 * as "DOOM Eternal Standard Edition (PC)" and Grand Theft Auto V as "Grand Theft Auto V Enhanced
 * (PC)"; GOG sells The Witcher 3 as a "Complete Edition". Those are the game, and a buyer who
 * looks for it is shown exactly them. What follows the name there is one of three kinds of word,
 * and each kind is on the list for its own reason:
 *
 * - `edition` — what a publisher calls the game sold again, whole: the plain edition
 *   (`standard`, `edition`), the game as it was reworked (`enhanced`, `remastered`, `definitive`,
 *   `director's cut`, `anniversary`), and the game with what was added to it since (`complete`,
 *   `game of the year`, `goty`, `gold`, `ultimate`). Every one of them contains the game.
 * - `platform` — where the product runs, which a store writes into the title when it lists one
 *   game once for each machine: `pc`, `windows`, `windows 10`, `xbox`, `one`, `series`, `x`, `s`,
 *   `x|s`.
 * - `joiner` — the small words such titles are strung together with: `for`, `the`, `and`, `&`.
 *   (The ampersand is punctuation, and punctuation between words counts for nothing anyway; it is
 *   here because the list is written down whole.)
 *
 * **What is deliberately not here.** `deluxe`, `premium`, `bundle`, `pack`, `season pass` and
 * `upgrade`: a product named by one of those is the game plus something sold with it, or
 * something sold for it, and its price is not the game's. And every word that is not an edition's
 * at all — a subtitle, a sequel's number, another game's name: `eternal` keeps "DOOM" away from
 * "DOOM Eternal", a digit keeps "Borderlands" away from "Borderlands 2", `mooncrash` keeps "Prey"
 * away from its add-on.
 *
 * An entry of several words is one phrase and counts only whole: `game of the year` puts neither
 * `game` nor `year` on the list, and `windows 10` does not put a digit there.
 */
export const EDITION_WORDS = {
  edition: [
    'standard',
    'edition',
    'enhanced',
    'remastered',
    'definitive',
    'complete',
    'game of the year',
    'goty',
    'gold',
    'ultimate',
    'anniversary',
    "director's cut",
  ],
  platform: ['pc', 'windows', 'windows 10', 'xbox', 'one', 'series', 'x', 's', 'x|s'],
  joiner: ['for', 'the', 'and', '&'],
} as const

/**
 * The words of `EDITION_WORDS` that name a machine only after another word, and which word that
 * is: `one` after `xbox`, and `x`, `s` and `x|s` after `series` (and `s` after the `x` it shares
 * a console generation with, as in "Series X/S").
 *
 * Standing alone each of them is something else. `X` is the tenth game of a series — "Mortal
 * Kombat X" is not an edition of "Mortal Kombat", nor "Mega Man X" of "Mega Man" — `one` is a
 * number spelled out, and a number after a name is a sequel, which is why no digit is on the list
 * either. The list is what the owner ruled; this is the one place it is read more narrowly than it
 * is written, and only ever towards finding nothing.
 */
export const EDITION_WORDS_ONLY_AFTER: Readonly<Record<string, readonly string[]>> = {
  one: ['xbox'],
  x: ['series'],
  s: ['series', 'x'],
  'x|s': ['series'],
}

/** A listed entry as the words it is made of, and whether it says anything by itself. */
interface EditionPhrase {
  words: string[]
  /** Not a joiner: a title needs one of these after the name to be an edition of the game. */
  names: boolean
}

/** Longest first, so that `windows 10` is tried before `windows`. */
const EDITION_PHRASES: EditionPhrase[] = Object.entries(EDITION_WORDS)
  .flatMap(([kind, entries]) =>
    entries.map((entry) => ({ words: entry.split(' '), names: kind !== 'joiner' })),
  )
  .sort((left, right) => right.words.length - left.words.length)

/** What separates two words of a title: whitespace, and punctuation other than an apostrophe. */
const SEPARATORS = /(?:\s|(?!')\p{P})+/u

/** Whether a character stands between words: whitespace, or punctuation that is no apostrophe. */
function isSeparator(character: string): boolean {
  return /^(?:\s|(?!')\p{P})$/u.test(character)
}

/**
 * Whether what follows a game's name in a title is made of edition words and nothing else. Both
 * are given as `comparableTitle` leaves them, and `rest` is the title without the name in front.
 *
 * - The name has to end where a word ends: "DOOMBRINGER" does not begin with the name "DOOM",
 *   and "Tony Hawk's" is not "Tony Hawk" with something after it — an apostrophe is part of a
 *   word.
 * - Punctuation separates words and counts for nothing: a colon, a dash, brackets, a slash, the
 *   ampersand. A symbol is not punctuation and is part of the word it stands in, so `x|s` is one
 *   word and is on the list, while "N++" does not begin with the name "N" and a "+" alone is a
 *   word the list does not have.
 * - Every word has to belong to a listed entry, whole (`EDITION_PHRASES`), in a place it may
 *   stand in (`EDITION_WORDS_ONLY_AFTER`).
 * - And at least one of them has to say something: a title that adds only "the" or "and" to a
 *   name, or only punctuation, names no edition, and is not taken for one.
 */
function isEditionSuffix(rest: string): boolean {
  if (rest === '' || !isSeparator(Array.from(rest)[0]!)) return false
  const words = rest.split(SEPARATORS).filter((word) => word !== '')

  let named = false
  let position = 0
  while (position < words.length) {
    const phrase = EDITION_PHRASES.find((candidate) =>
      candidate.words.every((word, offset) => words[position + offset] === word),
    )
    if (!phrase) return false
    const after = EDITION_WORDS_ONLY_AFTER[phrase.words.join(' ')]
    if (after && !after.includes(words[position - 1] ?? '')) return false
    named ||= phrase.names
    position += phrase.words.length
  }
  return named
}

/**
 * How a store's title names a game, when it does:
 *
 * - `'name'` — the title is the game's name (`comparableTitle` makes them the same string);
 * - `'edition'` — the title begins with the game's whole name, and everything after it is made of
 *   edition words (`EDITION_WORDS`);
 * - `null` — anything else, and a name or a title with nothing left in it once folded.
 */
export type TitleMatch = 'name' | 'edition'

/** `matchTitle` for two strings `comparableTitle` has already folded. */
export function matchComparableTitle(name: string, title: string): TitleMatch | null {
  if (name === '' || title === '') return null
  if (title === name) return 'name'
  return title.startsWith(name) && isEditionSuffix(title.slice(name.length)) ? 'edition' : null
}

export function matchTitle(
  name: string | null | undefined,
  title: string | null | undefined,
): TitleMatch | null {
  if (typeof name !== 'string' || typeof title !== 'string') return null
  return matchComparableTitle(comparableTitle(name), comparableTitle(title))
}

/** Whether two titles are one title, typography aside. Two that are empty once folded are not. */
export function isSameTitle(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return matchTitle(left, right) === 'name'
}

/**
 * How much earlier than the game a store's product may say it was released: a year. A store
 * lists a game before it is out — a pre-order, an early access — and dates the listing then.
 */
export const RELEASE_TOLERANCE_MS = 365 * 86_400_000

/** A document's release date (`YYYY-MM-DD`). */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** When a game was released, as epoch milliseconds, or `null` when the index does not know. */
export function gameReleasedAt(released: string | null | undefined): number | null {
  if (typeof released !== 'string' || !ISO_DAY.test(released)) return null
  const at = Date.parse(`${released}T00:00:00.000Z`)
  return Number.isFinite(at) ? at : null
}

/**
 * Whether a store's product can be the game by its date: released no more than a year before the
 * game was (`RELEASE_TOLERANCE_MS`).
 *
 * A title is shared by games years apart — a 2006 "Prey" and a 2017 one — and a product cannot be
 * older than the game it is. It can well be younger: a store re-lists a game, and dates the new
 * listing (the "Resident Evil Village" the Microsoft Store sells is dated 2026 for a game of
 * 2021), so nothing is asked of a later date.
 *
 * That is also where this guard ends, and it is written down so that nobody takes it for more.
 * An old game whose name a remake has taken — the first "Dead Space", once its own product is
 * gone from the store — is found under the remake's product, whose date is merely later.
 *
 * A game whose own release date the index does not hold cannot be held against anything, and is
 * found by a title nowhere: `false`.
 */
export function isReleasedInTime(
  gameReleased: string | null | undefined,
  productReleasedAt: number,
): boolean {
  const game = gameReleasedAt(gameReleased)
  return game !== null && productReleasedAt >= game - RELEASE_TOLERANCE_MS
}
