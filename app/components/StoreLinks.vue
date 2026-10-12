<script setup lang="ts">
/**
 * "Де купити": the stores a game is sold in, and what each of them charges where that is known.
 *
 * A store with a price is a row — the store, the price, when it was read — and the rows are one
 * list, so two prices are read one under the other. A store without a price stays what it always
 * was, a chip that is a link, in a row of chips under the list; a game no store has a price for
 * is the row of chips alone, exactly as before.
 *
 * - **Hryvnia** (Steam, the Microsoft Store): the discount chip, the price and the struck regular
 *   price, in the order and the classes of the catalog's `PriceTag`.
 * - **Dollars** (GOG): the price as the store writes it, `$8.99`, and beside it an estimate in
 *   hryvnia at the National Bank's rate — `≈ 404 ₴`, in the secondary colour and weight, because
 *   it is not a sum anybody is charged. The note under the block says what the estimate is; it is
 *   there only while an estimate is.
 * - **The store's own title** for the product, under the store's name, when it differs from the
 *   game's name (`namesAnotherProduct`): the link is sometimes to another edition, and the price
 *   is that edition's. It is another company's text and is rendered as text, never as markup.
 * - **«Найдешевше»** on the one row the answer marks. Which row that is, and that an estimate has
 *   to win by a margin, is the server's rule (`server/index/offerRules.ts`); nothing is compared
 *   here.
 *
 * A row is one link, and its accessible name is read in an order of its own: the store, the
 * mark, the title, then the price as one sentence — "−78% $8.99, було $39.99, приблизно 404 ₴" —
 * and its age. The eye takes the estimate right beside the price it is an estimate of, with the
 * struck price after both; heard in that order, "було" would attach to the estimate. So the
 * sentence is written out for a screen reader (`StoreRow.spoken`) and the pieces the eye reads are
 * hidden from it, sign and dot included.
 *
 * Nothing in a render path reads a clock: a price's age is counted against `now`, the moment the
 * answer on the page arrived, which the page hands down (`pages/games/[slug].vue`) as it does to
 * the scoreboard.
 */
import { STORE_OPTIONS } from '#shared/catalog'
import { safeExternalUrl } from '#shared/url'
import { hoursSince } from '~/utils/format'
import {
  formatForeignPrice,
  isPriceAmount,
  namesAnotherProduct,
  type ForeignMoney,
} from '~/utils/storeOffers'

interface Offer {
  store: string
  url: string
  title?: string | null
  priceUah?: number | null
  regularPriceUah?: number | null
  discountPercent?: number | null
  isFree?: boolean | null
  updatedAt?: string | null
  foreignPrice?: ForeignMoney | null
  foreignRegularPrice?: ForeignMoney | null
  approxUah?: number | null
  cheapest?: boolean | null
}

const props = defineProps<{
  offers: Offer[]
  /** The game's own name: a store's title is shown only when it names something else. */
  gameName?: string | null
  /** The day the bank's rate behind the estimates is for (`Game.exchangeRate.date`). */
  rateDate?: string | null
  /** ISO timestamp of the answer's arrival, from the page. Without it no row tells a price's age. */
  now?: string
}>()
const { t } = useI18n()
const { formatDate, formatNumber, formatUah } = useFormatters()
const storeName = (slug: string) =>
  STORE_OPTIONS.find((option) => option.slug === slug)?.name ?? slug

// The mapper already refuses anything that is not http(s) (server/rawg/mappers.ts), so this is
// defence in depth: the scheme check sits next to the `:href` it protects, where a future
// refactor that changes the data source cannot silently drop it.
const safeOffers = computed(() =>
  props.offers.flatMap((offer) => {
    const url = safeExternalUrl(offer.url)
    return url ? [{ ...offer, url }] : []
  }),
)

/**
 * A store's row with a price on it, as the template reads it: every figure already formatted.
 * Not what the server weighs a row as when it looks for the cheapest (`PricedRow`,
 * `server/index/offerRules.ts`) — that is an amount to compare, and nothing is compared here.
 */
interface StoreRow {
  store: string
  url: string
  cheapest: boolean
  /** What the store calls the product, when that is not the game's own name. */
  title: string | null
  free: boolean
  price: string
  /** The price has a decimal point, so it is set in the interface face (DESIGN.md, decimals). */
  decimal: boolean
  /** The hryvnia estimate of a price in another currency, already formatted. */
  estimate: string | null
  regular: string | null
  discount: number | null
  /**
   * The price as a screen reader says it: the discount and the price, then the price it was,
   * then the estimate — each with its word, a comma between them. "Безкоштовно" needs none.
   */
  spoken: string
  /** Whole hours since the price was read; `null` when that cannot be said. */
  hours: number | null
}

/**
 * The discount a chip may show: 1 to 99 percent, and only beside a regular price that is above
 * the price. "−0 %" and "−100 %" are not discounts anybody can read a price off, and a struck
 * price that is not higher is not one either — whatever the answer carries.
 */
function chipPercent(percent: number | null | undefined, onSale: boolean): number | null {
  return onSale && percent != null && percent >= 1 && percent <= 99 ? percent : null
}

/**
 * The sentence of a price for a screen reader (`StoreRow.spoken`): what it costs, what it cost,
 * about how much that is. In that order whatever the order on screen, and with the words the
 * strike and the sign stand for.
 */
function spokenPrice(parts: Pick<StoreRow, 'price' | 'regular' | 'estimate' | 'discount'>): string {
  return [
    `${parts.discount ? `−${parts.discount}% ` : ''}${parts.price}`,
    parts.regular ? `${t('price.was')} ${parts.regular}` : '',
    parts.estimate ? `${t('price.approximately')} ${parts.estimate}` : '',
  ]
    .filter(Boolean)
    .join(', ')
}

function storeRow(offer: Offer): StoreRow | null {
  // An amount below zero, or one that is not a number, is not a price: its store is a link
  // without one, like a store nobody has a price for. The server sends neither; nothing that
  // could be mistaken for a price is formatted on its word alone.
  const priceUah = isPriceAmount(offer.priceUah) ? offer.priceUah : null
  const foreign = isPriceAmount(offer.foreignPrice?.amount) ? offer.foreignPrice! : null
  if (priceUah === null && !foreign) return null
  const row = {
    store: offer.store,
    url: offer.url,
    cheapest: offer.cheapest === true,
    title: namesAnotherProduct(offer.title, props.gameName) ? (offer.title ?? null) : null,
    hours: offer.updatedAt && props.now ? hoursSince(offer.updatedAt, props.now) : null,
  }
  if (priceUah !== null) {
    // A missing `isFree` flag (an older/partial index entry) still reads as free when the price
    // itself is already 0 — never a formatted "0 ₴".
    const free = offer.isFree ?? priceUah === 0
    const onSale = !free && offer.regularPriceUah != null && offer.regularPriceUah > priceUah
    const parts = {
      price: formatUah(priceUah),
      estimate: null,
      regular: onSale ? formatUah(offer.regularPriceUah!) : null,
      discount: chipPercent(offer.discountPercent, onSale),
    }
    return { ...row, ...parts, free, decimal: false, spoken: spokenPrice(parts) }
  }
  const free = offer.isFree ?? foreign!.amount === 0
  const was = offer.foreignRegularPrice ?? null
  const onSale =
    !free && !!was && was.currency === foreign!.currency && was.amount > foreign!.amount
  const parts = {
    price: formatForeignPrice(foreign!),
    estimate: !free && offer.approxUah != null ? formatUah(offer.approxUah) : null,
    regular: onSale ? formatForeignPrice(was!) : null,
    discount: chipPercent(offer.discountPercent, onSale),
  }
  return { ...row, ...parts, free, decimal: true, spoken: spokenPrice(parts) }
}

/** Every store once, read once: with its priced row when it has a price to show. */
const stores = computed(() => safeOffers.value.map((offer) => ({ offer, row: storeRow(offer) })))
const priced = computed(() => stores.value.flatMap(({ row }) => (row ? [row] : [])))
const links = computed(() => stores.value.flatMap(({ offer, row }) => (row ? [] : [offer])))

/**
 * The note about the estimate, or nothing: only while GOG's row shows one, and only with the day
 * of the rate to name — the sentence is about that row and that rate, and says nothing true
 * without them.
 */
const estimateNote = computed(() => {
  const shown = priced.value.some((row) => row.store === 'gog' && row.estimate !== null)
  const date = formatDate(props.rateDate)
  return shown && date ? t('game.estimateNote', { date }) : ''
})
</script>

<template>
  <section v-if="safeOffers.length" aria-labelledby="where-to-buy">
    <h2 id="where-to-buy" class="font-display-heading text-xl text-fg">
      {{ t('game.whereToBuy') }}
    </h2>

    <ul
      v-if="priced.length"
      data-test="store-prices"
      class="mt-3 max-w-2xl rounded-card border border-line bg-surface-1"
    >
      <li
        v-for="(row, index) in priced"
        :key="`${row.store}-${index}`"
        :data-test="`store-row-${row.store}`"
        class="border-t border-line first:border-t-0 [&:first-child>a]:rounded-t-card [&:last-child>a]:rounded-b-card"
      >
        <!-- The focus ring is the site's own, two pixels outside the row, so it lies over the
             edge of the row next to it: the focused row is lifted above its neighbours, and a
             neighbour's hover colour cannot paint over the ring. -->
        <a
          :href="row.url"
          target="_blank"
          rel="noopener noreferrer"
          class="relative flex min-h-11 flex-col gap-x-4 gap-y-1.5 px-4 py-3 text-sm transition-colors duration-200 ease-out hover:bg-surface-2 focus-visible:z-10 focus-visible:outline-2 sm:flex-row sm:items-start sm:justify-between"
        >
          <span class="flex min-w-0 flex-col gap-0.5">
            <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span class="inline-flex items-center gap-1.5 font-medium text-fg">
                {{ storeName(row.store) }}
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  width="13"
                  height="13"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M6.5 3.5h6v6" />
                  <path d="M12.5 3.5 6 10" />
                  <path d="M9.5 3.5h-5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-5" />
                </svg>
              </span>
              <span
                v-if="row.cheapest"
                data-test="cheapest"
                class="rounded-chip border border-fg-2 px-2 py-0.5 text-xs font-medium text-fg"
                >{{ t('game.cheapest') }}</span
              >
            </span>
            <!-- Another company's text: interpolated, never bound as markup, and free to break
                 anywhere, so a title of two hundred characters wraps inside a phone's width. -->
            <span
              v-if="row.title"
              data-test="store-title"
              class="text-xs text-fg-2 [overflow-wrap:anywhere]"
              >{{ row.title }}</span
            >
          </span>

          <span class="flex shrink-0 flex-col gap-0.5 sm:items-end">
            <span data-test="store-price">
              <span v-if="row.free" class="font-medium text-fg">{{ t('price.free') }}</span>
              <template v-else>
                <!-- Said: the sentence. Seen: the pieces, in the order the eye wants them. -->
                <span data-test="store-price-spoken" class="sr-only">{{ row.spoken }}</span>
                <span
                  data-test="store-price-shown"
                  aria-hidden="true"
                  class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5"
                >
                  <span
                    v-if="row.discount"
                    class="font-numeric inline-flex items-center rounded-chip bg-sale px-1.5 py-0.5 text-xs font-semibold text-on-sale"
                    >−{{ row.discount }}%</span
                  >
                  <span
                    class="font-medium text-fg"
                    :class="row.decimal ? 'font-tabular' : 'font-numeric'"
                    >{{ row.price }}</span
                  >
                  <template v-if="row.estimate">
                    <span class="text-fg-2">·</span>
                    <span data-test="store-estimate" class="text-fg-2"
                      >≈&nbsp;<span class="font-numeric">{{ row.estimate }}</span></span
                    >
                  </template>
                  <s
                    v-if="row.regular"
                    class="text-fg-2"
                    :class="row.decimal ? 'font-tabular' : 'font-numeric'"
                    >{{ row.regular }}</s
                  >
                </span>
              </template>
            </span>
            <span v-if="row.hours === 0" class="text-xs text-fg-2">{{
              t('game.priceUpdatedRecently')
            }}</span>
            <i18n-t
              v-else-if="row.hours !== null"
              keypath="game.priceUpdated"
              tag="span"
              :plural="row.hours"
              class="text-xs text-fg-2"
            >
              <template #count
                ><span class="font-numeric">{{ formatNumber(row.hours) }}</span></template
              >
            </i18n-t>
          </span>
        </a>
      </li>
    </ul>

    <ul v-if="links.length" data-test="store-links" class="mt-3 flex flex-wrap gap-2">
      <li v-for="(offer, index) in links" :key="`${offer.store}-${index}`">
        <a
          :href="offer.url"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1.5 rounded-chip border border-line bg-surface-1 px-3 py-1.5 text-sm text-fg transition-colors duration-200 ease-out hover:bg-surface-2 focus-visible:outline-2"
        >
          {{ storeName(offer.store) }}
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M6.5 3.5h6v6" />
            <path d="M12.5 3.5 6 10" />
            <path d="M9.5 3.5h-5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-5" />
          </svg>
        </a>
      </li>
    </ul>

    <p
      v-if="estimateNote"
      data-test="estimate-note"
      class="mt-3 max-w-2xl text-xs text-pretty text-fg-2"
    >
      {{ estimateNote }}
    </p>
  </section>
</template>
