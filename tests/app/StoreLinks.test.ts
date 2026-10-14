import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, nextTick, type WritableComputedRef } from 'vue'
import StoreLinks from '~/components/StoreLinks.vue'

/**
 * "Де купити": a row for every store with a price, a chip for every store without one, and the
 * note about the estimate. The rows are given to the component as the BFF answers them — which row
 * is the cheapest, which price is fresh and what a dollar price comes to are the server's rules
 * (`tests/server/gamePageOffers.test.ts`); what is held here is what a visitor reads of them.
 */

const NOW = '2026-10-12T12:00:00.000Z'
const STEAM_URL = 'https://store.steampowered.com/app/292030/'
const GOG_URL = 'https://www.gog.com/en/game/the_witcher_3_wild_hunt'
const MICROSOFT_URL = 'https://www.microsoft.com/uk-ua/p/stardew-valley/c3d891z6tnqm'
const GAME = 'The Witcher 3: Wild Hunt'
const EDITION = 'The Witcher 3: Wild Hunt - Game of the Year Edition'

/** Steam at 675 ₴, down from 1 349 ₴, read three hours ago. */
const steam = {
  store: 'steam',
  url: STEAM_URL,
  title: null,
  priceUah: 675,
  regularPriceUah: 1349,
  discountPercent: 50,
  isFree: false,
  updatedAt: '2026-10-12T09:00:00.000Z',
  foreignPrice: null,
  foreignRegularPrice: null,
  approxUah: null,
  cheapest: false,
}

/** GOG at $8.99, down from $39.99, about 404 ₴, read six hours ago. */
const gog = {
  store: 'gog',
  url: GOG_URL,
  title: EDITION,
  priceUah: null,
  regularPriceUah: null,
  discountPercent: 78,
  isFree: false,
  updatedAt: '2026-10-12T06:00:00.000Z',
  foreignPrice: { amount: 8.99, currency: 'USD' },
  foreignRegularPrice: { amount: 39.99, currency: 'USD' },
  approxUah: 404,
  cheapest: true,
}

/** The Xbox Store at 385 ₴, at its regular price. */
const microsoft = {
  store: 'xbox-store',
  url: MICROSOFT_URL,
  title: 'Stardew Valley',
  priceUah: 385,
  regularPriceUah: null,
  discountPercent: 0,
  isFree: false,
  updatedAt: '2026-10-12T06:00:00.000Z',
  foreignPrice: null,
  foreignRegularPrice: null,
  approxUah: null,
  cheapest: false,
}

/** One store as the component takes it: the rows of the BFF's answer, every price field optional. */
type Offer = InstanceType<typeof StoreLinks>['$props']['offers'][number]

const mount = (offers: Offer[], props: Record<string, unknown> = {}) =>
  mountSuspended(StoreLinks, {
    props: { offers, gameName: GAME, rateDate: '2026-10-12', now: NOW, ...props },
  })

/**
 * An element's text, one run after another with a space between them and every kind of space —
 * the no-break ones included — a plain one, leaving out whatever sits inside an element that
 * matches `skip`. The pieces of a price are boxes of their own, laid out with a gap and with no
 * space character between them, so the markup's own `textContent` runs them together where
 * neither an eye nor a screen reader does.
 */
function textRuns(root: Element, skip: string): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const runs: string[] = []
  while (walker.nextNode()) {
    if (walker.currentNode.parentElement?.closest(skip)) continue
    const run = (walker.currentNode.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (run) runs.push(run)
  }
  return runs.join(' ')
}

/** What a screen reader says of the element: everything but what is hidden from it. */
const heard = (wrapper: { element: Element }) => textRuns(wrapper.element, '[aria-hidden="true"]')

/** What is on screen: everything but what is there for a screen reader alone. */
const seen = (wrapper: { element: Element }) => textRuns(wrapper.element, '.sr-only')

/**
 * Switches the messages the component renders with — see `tests/app/plurals.test.ts`, whose
 * approach this is: `locale.value`, because `setLocale()` also drives a navigation that never
 * settles here, and the English messages read off disk, because only the default locale's are
 * present in this environment.
 */
const LocaleProbe = defineComponent({
  setup: () => ({ i18n: useI18n() }),
  template: '<span />',
})

type Composer = {
  locale: WritableComputedRef<string>
  setLocaleMessage: (locale: string, messages: Record<string, unknown>) => void
}

async function withComposer(run: (i18n: Composer) => void): Promise<void> {
  const probe = await mountSuspended(LocaleProbe)
  run((probe.vm as unknown as { i18n: Composer }).i18n)
  await nextTick()
  probe.unmount()
}

const switchLocale = (locale: 'uk' | 'en') =>
  withComposer((i18n) => {
    i18n.locale.value = locale
  })

beforeAll(async () => {
  const path = resolve(process.cwd(), 'i18n/locales/en.json')
  const messages = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  await withComposer((i18n) => i18n.setLocaleMessage('en', messages))
})

afterEach(() => switchLocale('uk'))

describe('StoreLinks', () => {
  describe('a store without a price', () => {
    it('renders safe external links with store display names', async () => {
      const wrapper = await mount([
        { store: 'steam', url: STEAM_URL },
        { store: 'mystery-store', url: 'https://example.com/x' },
      ])
      const links = wrapper.findAll('a')
      expect(links.map((link) => link.text())).toEqual(['Steam', 'mystery-store'])
      expect(links[0]!.attributes('href')).toBe(STEAM_URL)
      expect(links[0]!.attributes('rel')).toBe('noopener noreferrer')
      expect(links[0]!.attributes('target')).toBe('_blank')
    })

    it('renders each store link as a pill button with a decorative external-link icon', async () => {
      const wrapper = await mount([{ store: 'steam', url: STEAM_URL }])
      const link = wrapper.get('a')
      expect(link.classes()).toContain('rounded-chip')
      const icon = link.find('svg')
      expect(icon.exists()).toBe(true)
      expect(icon.attributes('aria-hidden')).toBe('true')
    })

    it('is all the block has when no store has a price: no list of prices, no note', async () => {
      const wrapper = await mount([
        { store: 'steam', url: STEAM_URL },
        { store: 'gog', url: 'https://www.gog.com/x' },
      ])
      expect(wrapper.findAll('a').map((link) => link.text())).toEqual(['Steam', 'GOG'])
      expect(wrapper.find('[data-test="store-prices"]').exists()).toBe(false)
      expect(wrapper.find('[data-test="estimate-note"]').exists()).toBe(false)
      expect(wrapper.find('[data-test="cheapest"]').exists()).toBe(false)
    })

    it('stays a chip under the rows of the stores that have one', async () => {
      const wrapper = await mount([
        steam,
        { store: 'playstation-store', url: 'https://store.playstation.com/x' },
        gog,
      ])
      const rows = wrapper.get('[data-test="store-prices"]').findAll('a')
      expect(rows.map((row) => row.attributes('href'))).toEqual([STEAM_URL, GOG_URL])
      const chips = wrapper.get('[data-test="store-links"]').findAll('a')
      expect(chips.map((chip) => chip.text())).toEqual(['PlayStation Store'])
      expect(chips[0]!.classes()).toContain('rounded-chip')
    })
  })

  describe('links', () => {
    it('drops an offer whose url is not http(s), even if one reaches the component', async () => {
      const wrapper = await mount([
        { ...steam, url: 'javascript:alert(1)' },
        { store: 'gog', url: 'https://www.gog.com/x' },
      ])
      const links = wrapper.findAll('a')
      expect(links).toHaveLength(1)
      expect(links[0]!.attributes('href')).toBe('https://www.gog.com/x')
    })

    it('renders nothing when every offer url is unsafe', async () => {
      const wrapper = await mount([{ store: 'steam', url: 'data:text/html,x' }])
      expect(wrapper.find('section').exists()).toBe(false)
    })

    it('renders nothing without offers', async () => {
      const wrapper = await mount([])
      expect(wrapper.find('section').exists()).toBe(false)
    })

    it('opens a priced row in a new tab, at the address the answer gave, as one link', async () => {
      const wrapper = await mount([steam, gog])
      const row = wrapper.get('[data-test="store-row-gog"]')
      expect(row.findAll('a')).toHaveLength(1)
      const link = row.get('a')
      expect(link.attributes('href')).toBe(GOG_URL)
      expect(link.attributes('rel')).toBe('noopener noreferrer')
      expect(link.attributes('target')).toBe('_blank')
      expect(link.find('svg').attributes('aria-hidden')).toBe('true')
      // The whole row is the target, and never shorter than a finger needs.
      expect(link.classes()).toContain('min-h-11')
    })
  })

  describe('a store that charges in hryvnia', () => {
    it('shows the price, the price it was, the discount and how long ago it was read', async () => {
      const wrapper = await mount([steam])
      const row = wrapper.get('[data-test="store-row-steam"]')
      expect(seen(row)).toBe('Steam −50% 675 ₴ 1 349 ₴ оновлено 3 години тому')
      expect(row.get('s').text().replace(/\s/g, ' ')).toBe('1 349 ₴')
      expect(row.get('.bg-sale').text()).toBe('−50%')
      // "було" is for a screen reader; the strike says it to the eye.
      expect(heard(row)).toBe('Steam −50% 675 ₴, було 1 349 ₴ оновлено 3 години тому')
    })

    it('shows the Xbox Store’s price the same way, under the name the store filter gives it', async () => {
      const onSale = { ...microsoft, priceUah: 193, regularPriceUah: 385, discountPercent: 50 }
      const wrapper = await mount([onSale], { gameName: 'Stardew Valley' })
      const row = wrapper.get('[data-test="store-row-xbox-store"]')
      expect(seen(row)).toBe('Xbox Store −50% 193 ₴ 385 ₴ оновлено 6 годин тому')
      expect(heard(row)).toBe('Xbox Store −50% 193 ₴, було 385 ₴ оновлено 6 годин тому')
      expect(row.get('a').attributes('href')).toBe(MICROSOFT_URL)
    })

    it('shows a price with no discount chip and nothing struck when there is no sale', async () => {
      const wrapper = await mount([microsoft], { gameName: 'Stardew Valley' })
      const row = wrapper.get('[data-test="store-row-xbox-store"]')
      expect(seen(row.get('[data-test="store-price"]'))).toBe('385 ₴')
      expect(heard(row.get('[data-test="store-price"]'))).toBe('385 ₴')
      expect(row.find('s').exists()).toBe(false)
      expect(row.find('.bg-sale').exists()).toBe(false)
    })

    it('shows "Безкоштовно" for a free offer with an explicit isFree flag, not "0 ₴"', async () => {
      const free = {
        ...steam,
        priceUah: 0,
        regularPriceUah: null,
        discountPercent: 0,
        isFree: true,
      }
      const wrapper = await mount([free])
      const price = wrapper.get('[data-test="store-price"]')
      expect(price.text()).toBe('Безкоштовно')
      expect(wrapper.text()).not.toContain('₴')
    })

    it('also treats a 0 ₴ offer as free when isFree is missing (older/partial data)', async () => {
      const wrapper = await mount([{ store: 'steam', url: STEAM_URL, priceUah: 0 }])
      expect(wrapper.get('[data-test="store-price"]').text()).toBe('Безкоштовно')
      expect(wrapper.text()).not.toContain('₴')
    })

    it('says "щойно" for a price read within the half hour, and nothing of its age without a clock', async () => {
      const justNow = await mount([{ ...steam, updatedAt: '2026-10-12T11:50:00.000Z' }])
      expect(justNow.get('[data-test="store-row-steam"]').text()).toContain('оновлено щойно')
      const noClock = await mount([steam], { now: undefined })
      expect(noClock.get('[data-test="store-row-steam"]').text()).not.toContain('оновлено')
    })
  })

  describe('a store that charges in dollars', () => {
    it('shows the dollar price, then the estimate right beside it, then the price it was', async () => {
      const wrapper = await mount([steam, gog])
      const row = wrapper.get('[data-test="store-row-gog"]')
      expect(seen(row.get('[data-test="store-price"]'))).toBe('−78% $8.99 · ≈ 404 ₴ $39.99')
      expect(row.get('s').text()).toBe('$39.99')
      expect(row.text()).toContain('оновлено 6 годин тому')
    })

    it('is heard in another order: the price, the price it was, then about how much that is', async () => {
      // On screen "було" has a strike to stand for it and the estimate sits by its price. Read
      // out in that order, "було $39.99" would follow the estimate and seem to be about it.
      const wrapper = await mount([steam, gog])
      const row = wrapper.get('[data-test="store-row-gog"]')
      expect(heard(row.get('[data-test="store-price"]'))).toBe(
        '−78% $8.99, було $39.99, приблизно 404 ₴',
      )
      expect(heard(row)).toBe(
        `GOG Вигідно ${EDITION} −78% $8.99, було $39.99, приблизно 404 ₴ оновлено 6 годин тому`,
      )
    })

    it('says the price in one sentence and hides the pieces the eye reads, sign and dot with them', async () => {
      const wrapper = await mount([steam, gog])
      const price = wrapper.get('[data-test="store-row-gog"] [data-test="store-price"]')
      const spoken = price.get('[data-test="store-price-spoken"]')
      expect(spoken.classes()).toContain('sr-only')
      expect(spoken.text().replace(/\s/g, ' ')).toBe('−78% $8.99, було $39.99, приблизно 404 ₴')
      const shown = price.get('[data-test="store-price-shown"]')
      expect(shown.attributes('aria-hidden')).toBe('true')
      expect(shown.text()).toContain('≈')
      expect(shown.text()).toContain('·')
      // Nothing a screen reader is told has a sign in it to stumble over.
      expect(heard(price)).not.toMatch(/[≈·]/)
      // And nothing else sits beside the two: each word of the price is said once.
      expect(price.element.children).toHaveLength(2)
    })

    it('says only the parts a price has', async () => {
      const said = async (offer: Offer) => {
        const wrapper = await mount([offer])
        return heard(wrapper.get('[data-test="store-price"]'))
      }
      const noSale = { ...gog, discountPercent: 0, foreignRegularPrice: null }
      expect(await said(noSale)).toBe('$8.99, приблизно 404 ₴')
      expect(await said({ ...gog, approxUah: null })).toBe('−78% $8.99, було $39.99')
      expect(await said({ ...noSale, approxUah: null })).toBe('$8.99')
      expect(await said({ ...steam, discountPercent: 0, regularPriceUah: null })).toBe('675 ₴')
    })

    it('sets the estimate apart as secondary: the dollar price is the price', async () => {
      const wrapper = await mount([steam, gog])
      const price = wrapper.get('[data-test="store-row-gog"] [data-test="store-price"]')
      const dollars = price.findAll('span').find((node) => node.text() === '$8.99')!
      expect(dollars.classes()).toEqual(expect.arrayContaining(['font-medium', 'text-fg']))
      // A decimal is set in the interface face with tabular figures, never in mono.
      expect(dollars.classes()).toContain('font-tabular')
      const estimate = price.get('[data-test="store-estimate"]')
      expect(estimate.classes()).toContain('text-fg-2')
      expect(estimate.classes()).not.toContain('font-medium')
    })

    it('shows the dollar price alone when the answer has no estimate for it', async () => {
      const wrapper = await mount([steam, { ...gog, approxUah: null, cheapest: false }], {
        rateDate: null,
      })
      const price = wrapper.get('[data-test="store-row-gog"] [data-test="store-price"]')
      expect(seen(price)).toBe('−78% $8.99 $39.99')
      expect(heard(price)).toBe('−78% $8.99, було $39.99')
      expect(price.text()).not.toContain('≈')
      expect(wrapper.find('[data-test="store-estimate"]').exists()).toBe(false)
    })

    it('shows "Безкоштовно" for a game GOG gives away: no dollars, no estimate', async () => {
      const free = {
        ...gog,
        foreignPrice: { amount: 0, currency: 'USD' },
        foreignRegularPrice: null,
        discountPercent: 0,
        approxUah: null,
        isFree: true,
      }
      const wrapper = await mount([steam, free])
      const price = wrapper.get('[data-test="store-row-gog"] [data-test="store-price"]')
      expect(price.text()).toBe('Безкоштовно')
      expect(wrapper.find('[data-test="estimate-note"]').exists()).toBe(false)
    })
  })

  describe('an amount that is not a price', () => {
    it.each([
      ['a hryvnia price below zero', { ...steam, priceUah: -675 }, 'Steam'],
      ['a hryvnia price that is not a number', { ...steam, priceUah: Number.NaN }, 'Steam'],
      [
        'a dollar price below zero',
        { ...gog, foreignPrice: { amount: -8.99, currency: 'USD' } },
        'GOG',
      ],
      [
        'a dollar price that is not a number',
        { ...gog, foreignPrice: { amount: Number.NaN, currency: 'USD' } },
        'GOG',
      ],
    ])('shows no price for %s: the store is a link without one', async (_what, offer, name) => {
      const wrapper = await mount([offer as Offer])
      // No row, no figure, no sign: what the visitor is left with is where the game is sold.
      expect(wrapper.find('[data-test="store-prices"]').exists()).toBe(false)
      expect(wrapper.find('[data-test="store-price"]').exists()).toBe(false)
      expect(wrapper.find('[data-test="estimate-note"]').exists()).toBe(false)
      const chips = wrapper.get('[data-test="store-links"]').findAll('a')
      expect(chips.map((chip) => chip.text())).toEqual([name])
      expect(wrapper.text()).not.toMatch(/[-−$₴\d]/)
    })

    it('still shows the price of the store beside it', async () => {
      const broken = { ...gog, foreignPrice: { amount: -8.99, currency: 'USD' } }
      const wrapper = await mount([steam, broken])
      expect(wrapper.findAll('[data-test="store-prices"] a')).toHaveLength(1)
      expect(seen(wrapper.get('[data-test="store-row-steam"] [data-test="store-price"]'))).toBe(
        '−50% 675 ₴ 1 349 ₴',
      )
      expect(wrapper.get('[data-test="store-links"]').text()).toBe('GOG')
    })
  })

  describe('a discount', () => {
    it.each([
      [0, 'nothing'],
      [100, 'everything'],
      [-5, 'less than nothing'],
      [null, 'no percent at all'],
    ])(
      'draws no chip for a discount of %j (%s), and still strikes the higher price',
      async (percent, _what) => {
        const wrapper = await mount([
          { ...steam, discountPercent: percent },
          { ...gog, discountPercent: percent },
        ])
        expect(wrapper.find('.bg-sale').exists()).toBe(false)
        expect(wrapper.text()).not.toContain('%')
        expect(wrapper.findAll('s').map((node) => seen(node))).toEqual(['1 349 ₴', '$39.99'])
      },
    )

    it.each([1, 99])('draws the chip for %i %%', async (percent) => {
      const wrapper = await mount([{ ...gog, discountPercent: percent }])
      expect(wrapper.get('.bg-sale').text()).toBe(`−${percent}%`)
    })

    it('strikes nothing, and draws no chip, when the regular price is not above the price', async () => {
      const wrapper = await mount([
        { ...steam, regularPriceUah: 675 },
        { ...gog, foreignRegularPrice: { amount: 8.99, currency: 'USD' } },
        { ...microsoft, regularPriceUah: 300, discountPercent: 20 },
      ])
      expect(wrapper.find('s').exists()).toBe(false)
      expect(wrapper.find('.bg-sale').exists()).toBe(false)
    })
  })

  describe('what the store calls the product', () => {
    it('is shown under the store’s name when it names another edition', async () => {
      const wrapper = await mount([steam, gog])
      const title = wrapper.get('[data-test="store-row-gog"] [data-test="store-title"]')
      expect(title.text()).toBe(EDITION)
      expect(title.classes()).toContain('text-fg-2')
    })

    it.each([
      ['the game’s own name', GAME],
      ['the name in capitals', 'THE WITCHER 3: WILD HUNT'],
      ['the name with a trademark sign', 'The Witcher® 3: Wild Hunt™'],
      ['the name with other spacing', '  The Witcher 3:   Wild Hunt '],
      ['nothing', null],
    ])('is not shown when it is %s', async (_what, title) => {
      const wrapper = await mount([steam, { ...gog, title: title as string }])
      expect(wrapper.find('[data-test="store-title"]').exists()).toBe(false)
    })

    it('is rendered as the text it is: markup in a title is characters, not elements', async () => {
      const markup = '<img src=x onerror=alert(1)>'
      const wrapper = await mount([steam, { ...gog, title: markup }])
      const title = wrapper.get('[data-test="store-title"]')
      expect(title.text()).toBe(markup)
      expect(title.element.children).toHaveLength(0)
      expect(title.element.innerHTML).toBe('&lt;img src=x onerror=alert(1)&gt;')
      expect(wrapper.find('img').exists()).toBe(false)
      expect(wrapper.html()).not.toContain('<img')
    })

    it('is shown on the PlayStation Store’s row whatever it says, the game’s own name included', async () => {
      const playstation = {
        store: 'playstation-store',
        url: 'https://store.playstation.com/uk-ua/product/EP4497-CUSA05571_00-0000000000GOTY11',
        priceUah: 649,
        isFree: false,
        updatedAt: NOW,
        cheapest: false,
      }
      for (const title of [GAME, 'THE WITCHER 3: WILD HUNT', EDITION]) {
        const wrapper = await mount([steam, { ...playstation, title }])
        const shown = wrapper.get(
          '[data-test="store-row-playstation-store"] [data-test="store-title"]',
        )
        expect(shown.text()).toBe(title)
      }
      // A row with no title has nothing to show, whatever its store.
      const untitled = await mount([steam, { ...playstation, title: null }])
      expect(untitled.find('[data-test="store-title"]').exists()).toBe(false)
      // And the store's row is a hryvnia row like Steam's, under the store's own name.
      const row = (await mount([steam, { ...playstation, title: GAME }])).get(
        '[data-test="store-row-playstation-store"]',
      )
      expect(row.text()).toContain('PlayStation Store')
      expect(row.text()).toContain('649')
    })

    it('is allowed to break anywhere, so two hundred characters wrap inside the row', async () => {
      const long = 'W'.repeat(200)
      const wrapper = await mount([steam, { ...gog, title: long }])
      const title = wrapper.get('[data-test="store-title"]')
      expect(title.text()).toBe(long)
      expect(title.classes()).toContain('[overflow-wrap:anywhere]')
      // The column it sits in may shrink below its content's width.
      expect((title.element.parentElement as HTMLElement).className).toContain('min-w-0')
    })
  })

  describe('«Вигідно»', () => {
    it('is on the row the answer marks, and on no other', async () => {
      const wrapper = await mount([steam, gog, microsoft])
      const marks = wrapper.findAll('[data-test="cheapest"]')
      expect(marks).toHaveLength(1)
      expect(marks[0]!.text()).toBe('Вигідно')
      expect(
        wrapper.get('[data-test="store-row-gog"]').find('[data-test="cheapest"]').exists(),
      ).toBe(true)
    })

    it('is on no row when the answer marks none', async () => {
      const wrapper = await mount([steam, { ...gog, cheapest: false }])
      expect(wrapper.find('[data-test="cheapest"]').exists()).toBe(false)
    })

    it('uses none of the reserved colours: it is a fact about the price, not a sale', async () => {
      const wrapper = await mount([steam, gog])
      const classes = wrapper.get('[data-test="cheapest"]').classes().join(' ')
      expect(classes).not.toMatch(/accent|signal|sale/)
    })
  })

  describe('the note about the estimate', () => {
    it('is under the block while GOG’s row shows an estimate, with the day of the rate', async () => {
      const wrapper = await mount([steam, gog], { rateDate: '2026-10-09' })
      expect(wrapper.get('[data-test="estimate-note"]').text()).toBe(
        'GOG продає в доларах США. Сума в гривні приблизна, за курсом НБУ на 9 жовтня 2026; банк може списати іншу.',
      )
    })

    it.each([
      ['no store charges in dollars', [steam, microsoft], '2026-10-12'],
      ['GOG has no price', [steam, { store: 'gog', url: GOG_URL }], '2026-10-12'],
      ['GOG’s price has no estimate', [steam, { ...gog, approxUah: null }], null],
      ['the answer names no day for the rate', [steam, gog], null],
      ['the day is not a day', [steam, gog], 'yesterday'],
    ])('is absent when %s', async (_when, offers, rateDate) => {
      const wrapper = await mount(offers as Offer[], { rateDate })
      expect(wrapper.find('[data-test="estimate-note"]').exists()).toBe(false)
    })
  })

  describe('in English', () => {
    it('reads the same prices with the English words and separators', async () => {
      await switchLocale('en')
      const wrapper = await mount(
        [
          { ...steam, cheapest: false },
          { ...gog, approxUah: 1348 },
        ],
        { rateDate: '2026-10-09' },
      )
      expect(heard(wrapper.get('[data-test="store-row-steam"]'))).toBe(
        'Steam −50% 675 ₴, was 1,349 ₴ updated 3 hours ago',
      )
      expect(heard(wrapper.get('[data-test="store-row-gog"]'))).toBe(
        `GOG Good deal ${EDITION} −78% $8.99, was $39.99, approximately 1,348 ₴ updated 6 hours ago`,
      )
      expect(seen(wrapper.get('[data-test="store-row-gog"]'))).toBe(
        `GOG Good deal ${EDITION} −78% $8.99 · ≈ 1,348 ₴ $39.99 updated 6 hours ago`,
      )
      expect(wrapper.get('[data-test="estimate-note"]').text()).toBe(
        "GOG charges in US dollars. The hryvnia amount is an estimate at the National Bank of Ukraine's rate of October 9, 2026; your bank may charge a different sum.",
      )
    })

    it('writes the dollar price exactly as the Ukrainian page does, and groups the estimate its own way', async () => {
      const offers = [{ ...gog, approxUah: 1348 }]
      const ukrainian = await mount(offers)
      // Read before the switch: the mounted page follows the locale it is in.
      const uk = ukrainian.get('[data-test="store-price"]')
      const [ukSeen, ukHeard] = [seen(uk), heard(uk)]
      await switchLocale('en')
      const english = await mount(offers)
      const en = english.get('[data-test="store-price"]')

      expect(ukSeen).toBe('−78% $8.99 · ≈ 1 348 ₴ $39.99')
      expect(seen(en)).toBe('−78% $8.99 · ≈ 1,348 ₴ $39.99')
      expect(ukHeard).toBe('−78% $8.99, було $39.99, приблизно 1 348 ₴')
      expect(heard(en)).toBe('−78% $8.99, was $39.99, approximately 1,348 ₴')
    })
  })
})
