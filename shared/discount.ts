/**
 * The percent a discount chip may show, or `null` for no chip: 1 to 99, and only beside a regular
 * price that is above the price (`onSale`).
 *
 * "−0 %" and "−100 %" are not discounts anybody can read a price off, and a percent with no
 * higher price beside it has nothing to be a discount on. The refresh job writes 0, 1 to 99, or
 * 100 for a game given away; but a document is whatever the store holds, and one that carries a 0
 * beside a higher regular price, or a 100 beside a price that is not zero, gets no chip.
 *
 * One rule for both sides of the answer about another store's price: the server serves a
 * discount by it (`toStoreOffer`, `server/index/toGraphql.ts`), and the game page's block draws a
 * chip by it again (`StoreLinks.vue`), for Steam's row as for the others, so that neither has to
 * take the other's word. The catalog's own `PriceTag` is not a caller: this module is loaded with
 * a game page, never with the catalog.
 */
export function chipPercent(percent: number | null | undefined, onSale: boolean): number | null {
  return onSale && typeof percent === 'number' && percent >= 1 && percent <= 99 ? percent : null
}
