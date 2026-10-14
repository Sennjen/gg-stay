import { groupInteger } from './format'

/**
 * What the game page's "Де купити" block needs beyond the catalog's own formatters: a price in a
 * currency other than the hryvnia, and whether a store's name for a product is worth showing.
 *
 * It is a module of its own, and not part of `format.ts`, because only the game page uses it: the
 * catalog loads `format.ts` on first visit, and its JavaScript budget has no room for a helper it
 * never calls.
 */

export interface ForeignMoney {
  /** In the currency's main unit: 8.99 is eight dollars ninety-nine. */
  amount: number
  /** The ISO 4217 code. */
  currency: string
}

/**
 * Whether a number can be a price: zero or more. An amount below zero is not a price, and neither
 * is one that is not a number — the server passes over an offer that carries either
 * (`readableOffers`, `server/index/offerRules.ts`), and the block asks this again before it
 * formats anything, so that what is not a price is shown as a store without one and never as a
 * figure with a sign in it.
 */
export function isPriceAmount(amount: number | null | undefined): amount is number {
  return typeof amount === 'number' && amount >= 0
}

/**
 * A price in the currency a store charges in, written the way the store itself writes it:
 * "$8.99". The same characters in both locales, on purpose — it is the store's own figure, the
 * one the visitor will see on the store's page and on a bank statement, so it is quoted rather
 * than translated: no decimal comma, no symbol moved behind the number.
 *
 * Every character is this module's, like every price the site formats (`formatUah` says why): the
 * server renders the string and the browser hydrates it, and the two must not disagree about a
 * separator. Cents are always two digits; thousands are grouped with a comma, as the store would.
 * Only the dollar has a symbol here, because it is the only foreign currency the index carries —
 * anything else is written with its code after the number rather than guessed at.
 *
 * The amount is a price (`isPriceAmount`): the block hands over nothing else, and nothing here
 * tidies one that is not — a sign quietly dropped would turn a broken amount into a wrong price.
 */
export function formatForeignPrice(price: ForeignMoney): string {
  const cents = Math.round(price.amount * 100)
  const figure = `${groupInteger(Math.floor(cents / 100), 'en')}.${String(cents % 100).padStart(2, '0')}`
  return price.currency === 'USD' ? `$${figure}` : `${figure}\u00a0${price.currency}`
}

/** The signs a store puts in a title and a catalog leaves out of a name. */
const TRADEMARK_SIGNS = /[™®©]/g

/** A name as two names are compared: case, trademark signs and spacing do not make a difference. */
function comparable(text: string): string {
  return text.toLowerCase().replace(TRADEMARK_SIGNS, '').replace(/\s+/g, ' ').trim()
}

/**
 * The stores whose title for the product is shown on its row whatever it says: the PlayStation
 * Store. Its price is for the product Sony puts first for the game's concept, which is a
 * console's copy and is sometimes another product altogether, so the row always says which
 * product the price is for — the game's own name included.
 */
const ALWAYS_TITLED_STORES: readonly string[] = ['playstation-store']

/**
 * What a store's row shows under the store's name: the store's title for the product, or `null`
 * for nothing. For a store in `ALWAYS_TITLED_STORES`, the title whenever there is one; for any
 * other, only when it names something else than the game (`namesAnotherProduct`).
 */
export function shownTitle(
  store: string,
  title: string | null | undefined,
  gameName: string | null | undefined,
): string | null {
  if (ALWAYS_TITLED_STORES.includes(store)) return title?.trim() ? title : null
  return namesAnotherProduct(title, gameName) ? (title ?? null) : null
}

/**
 * Whether what a store calls a product differs from the game's own name, so that the page should
 * show it: a store's link is sometimes to another edition than the game it is filed under — a
 * "Game of the Year Edition", a complete season — and the price is that edition's.
 *
 * The two are compared after lower-casing, dropping the signs ™ ® ©, collapsing every run of
 * whitespace to one space and trimming. So `Batman™: Arkham Knight` and `METRO EXODUS` are the
 * game's own name and are not shown, while `… - Game of the Year Edition`, `… Standard Edition`
 * and a title in another language are. Nothing cleverer is attempted: what differs after that is
 * shown as the store wrote it, and a visitor reads it for what it is.
 *
 * A title that is missing, or empty once folded, is nothing to show.
 */
export function namesAnotherProduct(
  title: string | null | undefined,
  gameName: string | null | undefined,
): boolean {
  if (!title) return false
  const folded = comparable(title)
  return folded !== '' && folded !== comparable(gameName ?? '')
}
