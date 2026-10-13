import { describe, expect, it } from 'vitest'
import { MAX_OFFER_TITLE_LENGTH } from '../../../server/index/document'
import type { IndexMeta, IndexedGame } from '../../../server/index/document'
import { createMemoryGameIndex } from '../../../server/index/memoryIndex'
import { parsePlaystationConcept, parsePlaystationPrice } from '../../../scripts/index/playstation'
import { playstationTitleFromUrl } from '../../../scripts/index/storeRefs'
import {
  DEV_FIXTURE_GAMES,
  DEV_FIXTURE_META_EXTRA,
  DEV_FIXTURE_PRICES_UPDATED_AT,
  DEV_FIXTURE_SHELF_GAMES,
  DEV_FIXTURE_UKRAINIAN_GAMES,
} from '../../fixtures/index/devGames'
import { safeExternalUrl } from '../../../shared/url'
import sonyCyberpunkConcepts from '../../fixtures/playstation/concepts-CUSA16596_00.json' with { type: 'json' }
import sonyMetroConcepts from '../../fixtures/playstation/concepts-CUSA11408_00.json' with { type: 'json' }
import sonyStardewConcepts from '../../fixtures/playstation/concepts-CUSA06840_00.json' with { type: 'json' }
import sonyCyberpunkPrice from '../../fixtures/playstation/price-234567.json' with { type: 'json' }
import sonyMetroPrice from '../../fixtures/playstation/price-231769.json' with { type: 'json' }
import sonyStardewPrice from '../../fixtures/playstation/price-227229.json' with { type: 'json' }
import rawgCyberpunk from '../../fixtures/rawg/game-cyberpunk-2077.json' with { type: 'json' }
import rawgCyberpunkStores from '../../fixtures/rawg/game-cyberpunk-2077-stores.json' with { type: 'json' }
import rawgMetro from '../../fixtures/rawg/game-metro-exodus.json' with { type: 'json' }
import rawgMetroStores from '../../fixtures/rawg/game-metro-exodus-stores.json' with { type: 'json' }
import rawgStardew from '../../fixtures/rawg/game-stardew-valley.json' with { type: 'json' }
import rawgStardewStores from '../../fixtures/rawg/game-stardew-valley-stores.json' with { type: 'json' }
import rawgWitcherStores from '../../fixtures/rawg/game-the-witcher-3-wild-hunt-stores.json' with { type: 'json' }
import bankRate from '../../fixtures/nbu/exchange.json' with { type: 'json' }
import gogCatalog from '../../fixtures/gog/catalog.json' with { type: 'json' }
import published from '../../fixtures/index/published.json' with { type: 'json' }

/**
 * `published.json` is the version a development server (and CI, and anything else without Upstash
 * credentials) seeds its in-memory index from. It holds exactly the games the RAWG fixtures show,
 * so fixture mode renders real prices, a discount, a free game and the localisation badge — the
 * states the interface has, and the states a reviewer has to be able to see.
 *
 * It is pinned to `devGames.ts` here, because a fixture that drifts from the module the tests
 * reason about would make a development server disagree with every test.
 */

const fixture = published as unknown as { meta: IndexMeta; games: IndexedGame[] }

describe('the published index fixture', () => {
  it('holds exactly the development games', () => {
    expect(fixture.games).toEqual([
      ...DEV_FIXTURE_GAMES,
      ...DEV_FIXTURE_UKRAINIAN_GAMES,
      ...DEV_FIXTURE_SHELF_GAMES,
    ])
    expect(fixture.meta.gameCount).toBe(fixture.games.length)
  })

  it('holds at least five games made in Ukraine, so the shelf and the filter have something', async () => {
    const index = createMemoryGameIndex()
    const version = await index.beginVersion()
    await index.writeVersion(version, fixture.games)
    await index.publish(version, { ...fixture.meta, version })

    const madeInUkraine = await index.search({ madeInUkraine: true })
    expect(madeInUkraine.total).toBeGreaterThanOrEqual(5)
    expect(madeInUkraine.ids).toEqual(DEV_FIXTURE_UKRAINIAN_GAMES.map((game) => game.id))
  })

  /**
   * A landing shelf, and the similar-games row, is not shown with fewer than four games. The seed
   * has to reach four on every index shelf and for The Witcher 3's similar games, or fixture mode
   * — the dev server, CI's SSR suite, a reviewer's browser — could never render them.
   */
  it('fills every index shelf and The Witcher 3 similar games with at least four games', async () => {
    const index = createMemoryGameIndex()
    const version = await index.beginVersion()
    await index.writeVersion(version, fixture.games)
    await index.publish(version, { ...fixture.meta, version })

    const slugs = async (query: Parameters<typeof index.search>[0]) =>
      (await index.search(query)).games.map((game) => game.slug)
    expect(await slugs({ ukrainianLocalisation: 'ANY' })).toEqual([
      'the-witcher-3-wild-hunt',
      'portal-2',
      'half-life-2',
      'cyberpunk-2077',
    ])
    expect(await slugs({ onSaleMinPercent: 30 })).toEqual([
      'the-witcher-3-wild-hunt',
      'portal-2',
      'the-witcher-2-assassins-of-kings-enhanced-edition',
      'metro-exodus',
    ])
    const similar = (await slugs({ genres: ['action', 'role-playing-games-rpg'] })).filter(
      (slug) => slug !== 'the-witcher-3-wild-hunt',
    )
    expect(similar.length).toBeGreaterThanOrEqual(4)
  })

  it('dates every price it knows, so a price is never served without its timestamp', () => {
    for (const game of fixture.games) {
      if (game.priceUah !== null) expect(game.priceUpdatedAt).not.toBeNull()
    }
  })

  it('publishes through the writer port as it stands', async () => {
    const index = createMemoryGameIndex()
    const version = await index.beginVersion()
    await index.writeVersion(version, fixture.games)
    await index.publish(version, { ...fixture.meta, version })
    expect((await index.search({ ukrainianLocalisation: 'AUDIO' })).ids).toEqual([3328])
    expect((await index.search({ free: true })).ids).toEqual([654])
    // Cheapest first: the free game, The Witcher 2 on sale, the two 225 ₴ games (the more popular
    // first), then the dearer ones up to Cyberpunk 2077 at 1 399 ₴.
    expect((await index.search({ sort: 'PRICE_ASC' })).ids).toEqual([
      654, 16944, 4200, 13537, 3328, 28201, 447825, 41494,
    ])
    expect((await index.meta())?.gameCount).toBe(fixture.games.length)
  })

  /**
   * The seed has to be able to answer the design's own acceptance URL with something, or the
   * "every card is under the ceiling AND over the discount floor" half of it is never exercised.
   * Portal 2 (225 ₴ at −75 %) and The Witcher 2 (59 ₴ at −85 %) are those games, both on PC, so
   * the discount order between them is observable too.
   */
  it('holds two games that are both cheap and heavily discounted, on PC', () => {
    const cheapAndDiscounted = fixture.games.filter(
      (game) =>
        game.priceUah !== null &&
        game.priceUah > 0 &&
        game.priceUah <= 300 &&
        game.discountPercent !== null &&
        game.discountPercent >= 50 &&
        game.platforms.includes(4),
    )
    expect(cheapAndDiscounted.map((game) => game.slug)).toEqual([
      'portal-2',
      'the-witcher-2-assassins-of-kings-enhanced-edition',
    ])
  })

  it('has no two games sharing a discount, so a discount order is never a tie-break', async () => {
    const discounts = fixture.games
      .map((game) => game.discountPercent)
      .filter((percent): percent is number => typeof percent === 'number' && percent > 0)
    expect(new Set(discounts).size).toBe(discounts.length)

    const index = createMemoryGameIndex()
    const version = await index.beginVersion()
    await index.writeVersion(version, fixture.games)
    await index.publish(version, { ...fixture.meta, version })
    // The Witcher 2 at −85 %, Portal 2 at −75 %, The Witcher 3 at −50 % and Metro Exodus at
    // −40 %, then the undiscounted priced games at zero — the free one among them — by popularity.
    expect((await index.search({ sort: 'DISCOUNT_DESC' })).ids).toEqual([
      16944, 4200, 3328, 28201, 13537, 41494, 654, 447825,
    ])
    expect((await index.search({ priceMaxUah: 300, onSaleMinPercent: 50 })).ids).toEqual([
      4200, 16944,
    ])
  })

  /**
   * What GOG and the Microsoft Store charge, seeded so that a page has every case to render: a
   * dollar offer and a hryvnia one, one stale, a GOG price clearly below Steam's and one that is
   * not. The cases are measured the way the design measures them. What the PlayStation Store
   * charges is seeded beside them and has cases of its own, below.
   */
  describe('the offers of the other stores', () => {
    const HOUR = 3_600_000
    const runAt = Date.parse(DEV_FIXTURE_PRICES_UPDATED_AT)
    const offered = fixture.games
      .map((game) => ({
        ...game,
        offers: game.offers?.filter((offer) => offer.store !== 'playstation-store'),
      }))
      .filter((game) => (game.offers?.length ?? 0) > 0)
    const offerOf = (id: number, store: string) =>
      fixture.games.find((game) => game.id === id)?.offers?.find((offer) => offer.store === store)
    const isFresh = (updatedAt: string) => runAt - Date.parse(updatedAt) <= 36 * HOUR
    /** A dollar amount in whole hryvnia at the fixture's rate, as a page estimates it. */
    const estimate = (cents: number) => Math.round((cents / 100) * fixture.meta.exchangeRate!.uah)

    it('carries the rate and the store stamps beside the offers', () => {
      expect(fixture.meta).toMatchObject(DEV_FIXTURE_META_EXTRA)
      // The National Bank's own rate, as recorded.
      expect(fixture.meta.exchangeRate?.uah).toBe(bankRate[0]!.rate)
      // The rate was read by the fixture's run, so it is in date.
      expect(fixture.meta.exchangeRate?.readAt).toBe(DEV_FIXTURE_PRICES_UPDATED_AT)
    })

    it('holds a dollar offer from GOG and a hryvnia offer from the Microsoft Store', () => {
      expect(offered.map((game) => game.slug)).toEqual([
        'the-witcher-3-wild-hunt',
        'stardew-valley',
        'metro-exodus',
        'sherlock-holmes-chapter-one',
      ])
      expect(offerOf(3328, 'gog')).toMatchObject({ currency: 'USD', amount: 899 })
      expect(offerOf(654, 'xbox-store')).toMatchObject({ currency: 'UAH', amount: 38_500 })
      for (const game of offered) {
        // At most one a store, every amount whole minor units, and every link one a page may show.
        expect(new Set(game.offers!.map((offer) => offer.store)).size).toBe(game.offers!.length)
        for (const offer of game.offers!) {
          expect(Number.isInteger(offer.amount) && Number.isInteger(offer.regularAmount)).toBe(true)
          expect(offer.regularAmount).toBeGreaterThanOrEqual(offer.amount)
          expect(offer.currency).toBe(offer.store === 'gog' ? 'USD' : 'UAH')
          expect(safeExternalUrl(offer.url)).toBe(offer.url)
        }
      }
    })

    it('holds one game where GOG is clearly cheaper than Steam, and one where it is not', () => {
      const witcher = fixture.games.find((game) => game.id === 3328)!
      const metro = fixture.games.find((game) => game.id === 28201)!

      // The design's own example: $8.99 is ≈ 404 ₴, and that is far more than a tenth below
      // Steam's 675 ₴.
      expect(estimate(offerOf(3328, 'gog')!.amount)).toBe(404)
      expect(estimate(offerOf(3328, 'gog')!.amount)).toBeLessThanOrEqual(witcher.priceUah! * 0.9)
      // $29.99 is ≈ 1 348 ₴, against Steam's 749 ₴.
      expect(estimate(offerOf(28201, 'gog')!.amount)).toBe(1348)
      expect(estimate(offerOf(28201, 'gog')!.amount)).toBeGreaterThan(metro.priceUah!)
    })

    it('holds one stale offer, which would have been the cheapest had it been fresh', () => {
      const stale = offered
        .flatMap((game) => game.offers!)
        .filter((offer) => !isFresh(offer.updatedAt))
      const sherlock = fixture.games.find((game) => game.id === 447825)!

      expect(stale).toEqual([offerOf(447825, 'gog')])
      expect(estimate(stale[0]!.amount)).toBeLessThan(sherlock.priceUah! * 0.9)
    })

    /**
     * The store's own title travels with an offer so that a page can say which edition a price is
     * for. A page shows it when it differs from the game's name, case and surrounding whitespace
     * ignored — which is the comparison made here, so the seed has every outcome of it.
     */
    it('holds a title that names another edition, one that is the game’s name, and none', () => {
      const sameName = (left: string, right: string) =>
        left.trim().toLocaleLowerCase('en') === right.trim().toLocaleLowerCase('en')
      const titleOf = (id: number, store: string) => {
        const game = fixture.games.find((candidate) => candidate.id === id)!
        const title = offerOf(id, store)?.title
        return { title, differs: title === undefined ? null : !sameName(title, game.name) }
      }

      expect(titleOf(3328, 'gog')).toEqual({
        title: 'The Witcher 3: Wild Hunt — Remastered',
        differs: true,
      })
      expect(titleOf(654, 'xbox-store')).toEqual({ title: 'Stardew Valley', differs: false })
      // The same name but for its capitals: not another edition.
      expect(titleOf(28201, 'gog')).toEqual({ title: 'METRO EXODUS', differs: false })
      // The store gave none: the field is not there, rather than there and empty.
      expect(titleOf(447825, 'gog')).toEqual({ title: undefined, differs: null })
      expect('title' in offerOf(447825, 'gog')!).toBe(false)

      for (const game of offered) {
        for (const offer of game.offers!) {
          if (offer.title === undefined) continue
          expect(offer.title).toBe(offer.title.trim())
          expect(offer.title.length).toBeGreaterThan(0)
          expect(Array.from(offer.title).length).toBeLessThanOrEqual(MAX_OFFER_TITLE_LENGTH)
        }
      }
    })

    /**
     * The Witcher 3's GOG offer is the design's example, and the one a development page links
     * out from, so it names a product GOG's catalog really holds for Ukraine: the recorded pack,
     * at its own address and under its own title. The slug RAWG's link carries for the game is
     * not in that catalog, and a seed naming it would lead nowhere.
     */
    it('names, for The Witcher 3, a product GOG’s recorded catalog holds — not the slug of RAWG’s link', () => {
      const offer = offerOf(3328, 'gog')!
      const product = gogCatalog.products.find((candidate) => candidate.storeLink === offer.url)

      expect(product).toMatchObject({
        slug: 'the_witcher_3_wild_hunt_game_of_the_year_edition',
        productType: 'pack',
        title: offer.title,
      })
      const linked = rawgWitcherStores.results.find((link) => link.store_id === 5)!.url
      expect(linked.endsWith('/game/the_witcher_3_wild_hunt')).toBe(true)
      expect(gogCatalog.products.map((candidate) => candidate.slug)).not.toContain(
        'the_witcher_3_wild_hunt',
      )
    })

    it('offers a store only where the game is listed on it, and RAWG’s fixture links it', () => {
      for (const game of offered) {
        for (const offer of game.offers!) expect(game.stores, game.slug).toContain(offer.store)
      }
      // The two offered games a RAWG fixture exists for: the row the offer belongs to is there.
      expect(rawgWitcherStores.results.map((link) => link.store_id)).toContain(5)
      expect(rawgStardewStores.results.map((link) => link.store_id)).toContain(2)
    })
  })

  /**
   * What the PlayStation Store charges, seeded so that the pages that will show it have every
   * case of its own to render: a sale that is still on, a sale that is over, an offer too old to
   * be a price — and the product's name where it is the game's own. Each on a game whose page the
   * fixture build can open, which takes a RAWG recording of the game.
   */
  describe('the offers of the PlayStation Store', () => {
    const HOUR = 3_600_000
    const runAt = Date.parse(DEV_FIXTURE_PRICES_UPDATED_AT)
    const METRO = 28201
    const STARDEW = 654
    const CYBERPUNK = 41494
    const gameOf = (id: number) => fixture.games.find((game) => game.id === id)!
    const offerOf = (id: number) =>
      gameOf(id).offers!.find((offer) => offer.store === 'playstation-store')!
    const ageOf = (id: number) => runAt - Date.parse(offerOf(id).updatedAt)

    it('is on three games, in hryvnia, at the product’s page in the Ukrainian store', () => {
      const seeded = fixture.games.filter((game) =>
        game.offers?.some((offer) => offer.store === 'playstation-store'),
      )
      expect(seeded.map((game) => game.id)).toEqual([STARDEW, METRO, CYBERPUNK])
      for (const game of seeded) {
        const offer = offerOf(game.id)
        // RAWG lists the game on the store: an offer without that is one no page would show.
        expect(game.stores, game.slug).toContain('playstation-store')
        expect(offer.currency).toBe('UAH')
        expect(Number.isInteger(offer.amount) && Number.isInteger(offer.regularAmount)).toBe(true)
        expect(offer.regularAmount).toBeGreaterThanOrEqual(offer.amount)
        expect(offer.url).toMatch(
          /^https:\/\/store\.playstation\.com\/uk-ua\/product\/[A-Z]{2}\d{4}-[A-Z]{4}\d{5}_\d{2}-[A-Z0-9]{16}$/,
        )
        expect(safeExternalUrl(offer.url)).toBe(offer.url)
        // After the game's other offers, in the stores' own order.
        expect(game.offers!.at(-1)).toBe(offer)
      }
      // The store is read a game at a time: the metadata has no stamp for it.
      expect(fixture.meta.offersReadAt).toEqual(DEV_FIXTURE_META_EXTRA.offersReadAt)
      expect(Object.keys(fixture.meta.offersReadAt!)).not.toContain('playstation-store')
    })

    it('holds a fresh offer on sale, whose sale has days to run', () => {
      const offer = offerOf(METRO)

      expect(ageOf(METRO)).toBeLessThan(36 * HOUR)
      expect(offer).toMatchObject({ amount: 9_490, regularAmount: 94_900, discountPercent: 90 })
      expect(Date.parse(offer.saleEndsAt!) - runAt).toBeGreaterThan(8 * 24 * HOUR)
      // Far below every other price on the game's page: Steam's, and GOG's at the bank's rate.
      const metro = gameOf(METRO)
      expect(offer.amount / 100).toBeLessThan(metro.priceUah! * 0.9)
      expect(metro.offers!.map((entry) => entry.store)).toEqual(['gog', 'playstation-store'])
    })

    it('holds a fresh offer whose sale is over', () => {
      const offer = offerOf(STARDEW)

      // Read within the day and a half every store's offer is a price for, let alone this one's
      // two days.
      expect(ageOf(STARDEW)).toBeLessThan(36 * HOUR)
      expect(offer.amount).toBeLessThan(offer.regularAmount)
      expect(offer.discountPercent).toBe(30)
      // The sale was on when the offer was read, and has ended since.
      expect(Date.parse(offer.saleEndsAt!)).toBeGreaterThan(Date.parse(offer.updatedAt))
      expect(runAt - Date.parse(offer.saleEndsAt!)).toBeGreaterThan(8 * HOUR)
    })

    it('holds an offer older than forty-eight hours', () => {
      expect(ageOf(CYBERPUNK)).toBeGreaterThan(48 * HOUR)
      expect(offerOf(CYBERPUNK)).toMatchObject({ amount: 149_900, regularAmount: 149_900 })
      expect('saleEndsAt' in offerOf(CYBERPUNK)).toBe(false)
    })

    it('holds a product whose title is the game’s own name, on every one of them', () => {
      for (const id of [METRO, STARDEW, CYBERPUNK]) expect(offerOf(id).title).toBe(gameOf(id).name)
    })

    it('is on games the fixture build can open as pages: each has a RAWG recording', () => {
      const recorded = [
        [METRO, rawgMetro, rawgMetroStores],
        [STARDEW, rawgStardew, rawgStardewStores],
        [CYBERPUNK, rawgCyberpunk, rawgCyberpunkStores],
      ] as const
      for (const [id, detail, links] of recorded) {
        const game = gameOf(id)
        expect(detail).toMatchObject({ id, slug: game.slug, name: game.name })
        // The row the offer belongs to is among RAWG's links, with a title the job can read.
        const link = links.results.find((entry) => entry.store_id === 3)
        expect(playstationTitleFromUrl(link?.url), game.slug).not.toBeNull()
      }
    })

    it('names, for each, a product Sony’s recorded answers hold for the title RAWG links', () => {
      const titleOf = (links: typeof rawgMetroStores) =>
        playstationTitleFromUrl(links.results.find((entry) => entry.store_id === 3)!.url)!
      const productOf = (id: number) => offerOf(id).url.split('/').at(-1)!

      // Metro Exodus: the concept's default product, at the price Sony listed — which it listed
      // for the buyers of an experiment, so the job's own rule reads no price from it.
      const metro = parsePlaystationConcept(sonyMetroConcepts, titleOf(rawgMetroStores))
      expect(metro).toBe(231_769)
      const metroProduct = sonyMetroPrice.data.conceptRetrieve.defaultProduct
      expect(metroProduct).toMatchObject({ id: productOf(METRO), name: offerOf(METRO).title })
      const listed = metroProduct.webctas.find((entry) => entry.type === 'ADD_TO_CART')!.price
      expect(listed).toMatchObject({ discountedValue: 9_490, basePriceValue: 94_900 })
      expect(listed.qualifications.length).toBeGreaterThan(0)
      expect(parsePlaystationPrice(sonyMetroPrice, 231_769)).toBeNull()

      // Cyberpunk 2077: the default product and its price, as the job reads them.
      const cyberpunk = parsePlaystationConcept(sonyCyberpunkConcepts, titleOf(rawgCyberpunkStores))
      expect(parsePlaystationPrice(sonyCyberpunkPrice, cyberpunk!)).toMatchObject({
        id: productOf(CYBERPUNK),
        title: offerOf(CYBERPUNK).title,
        price: { amount: 149_900, regularAmount: 149_900 },
        url: offerOf(CYBERPUNK).url,
      })

      // Stardew Valley: the concept's one product, which Sony does not put first — so a real run
      // reads no price for it, and the seed's amounts are its own.
      const stardew = parsePlaystationConcept(sonyStardewConcepts, titleOf(rawgStardewStores))
      expect(stardew).toBe(227_229)
      expect(sonyStardewPrice.data.conceptRetrieve.products).toEqual([
        { id: productOf(STARDEW), name: offerOf(STARDEW).title },
      ])
      expect(parsePlaystationPrice(sonyStardewPrice, 227_229)).toBeNull()
    })
  })

  it('strikes a real pre-discount price through, rather than the same number twice', () => {
    for (const game of fixture.games) {
      if ((game.discountPercent ?? 0) > 0) {
        expect(game.regularPriceUah).toBeGreaterThan(game.priceUah!)
      }
    }
  })
})
