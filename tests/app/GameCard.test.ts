import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import GameCard from '~/components/GameCard.vue'
import LocalisationBadge from '~/components/LocalisationBadge.vue'
import MetacriticBadge from '~/components/MetacriticBadge.vue'
import PlatformIcons from '~/components/PlatformIcons.vue'
import PriceTag from '~/components/PriceTag.vue'

const game = {
  id: '3328',
  slug: 'the-witcher-3-wild-hunt',
  name: 'The Witcher 3: Wild Hunt',
  released: '2015-05-18',
  rating: 4.65,
  metacritic: 92,
  cover: { url: 'https://media.rawg.io/media/games/618/abc.jpg' },
  screenshots: [{ url: 'https://media.rawg.io/media/screenshots/1/shot.jpg' }],
  platformFamilies: ['PC', 'PLAYSTATION'] as const,
  platforms: [{ id: '4', slug: 'pc', name: 'PC' }],
  genres: [{ id: '4', slug: 'action', name: 'Action' }],
}

describe('GameCard', () => {
  it('links to the detail page and shows core data', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    expect(wrapper.get('a').attributes('href')).toBe('/games/the-witcher-3-wild-hunt')
    expect(wrapper.text()).toContain('The Witcher 3: Wild Hunt')
    expect(wrapper.text()).toContain('92')
  })

  it('shows only the release year, sliced from the ISO date, in mono', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    expect(wrapper.text()).toContain('2015')
    expect(wrapper.text()).not.toContain('травня')
    expect(wrapper.text()).not.toContain('18 травня 2015')
  })

  it('shows no year when released is missing', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game: { ...game, released: null } } })
    expect(wrapper.text()).not.toContain('2015')
  })

  it('renders a Metacritic badge when a score exists', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    expect(wrapper.findComponent(MetacriticBadge).exists()).toBe(true)
  })

  it('renders no Metacritic badge without a score', async () => {
    const wrapper = await mountSuspended(GameCard, {
      props: { game: { ...game, metacritic: null } },
    })
    expect(wrapper.findComponent(MetacriticBadge).exists()).toBe(false)
  })

  it('renders platform icons for the card platform families', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    expect(wrapper.findComponent(PlatformIcons).exists()).toBe(true)
  })

  it('renders an image with explicit dimensions and the game name as alt', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    const [cover] = wrapper.findAll('img')
    expect(cover!.attributes('alt')).toBe('The Witcher 3: Wild Hunt')
    expect(cover!.attributes('width')).toBe('420')
    expect(cover!.attributes('height')).toBe('236')
  })

  it('renders no price or localisation area when the game is not indexed', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    expect(wrapper.find('[data-test="price"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="localisation"]').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/N\/A|₴/)
  })

  it('renders a price line for an indexed game, price on the left and the badge on the right', async () => {
    const priced = {
      ...game,
      price: {
        bestUah: 337,
        regularUah: 1349,
        bestStore: 'steam',
        discountPercent: 75,
        isFree: false,
        updatedAt: '2026-09-18T09:00:00.000Z',
      },
      localisation: { text: true, audio: true, source: 'steam' },
    }
    const wrapper = await mountSuspended(GameCard, { props: { game: priced } })
    const price = wrapper.findComponent(PriceTag)
    const badge = wrapper.findComponent(LocalisationBadge)
    expect(price.exists()).toBe(true)
    expect(badge.exists()).toBe(true)
    expect(wrapper.find('[data-test="price"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="localisation"]').exists()).toBe(true)

    const row = wrapper.get('[data-test="price"]').element.parentElement!
    const children = Array.from(row.children)
    expect(children.indexOf(price.element)).toBeLessThan(children.indexOf(badge.element))
  })

  it('renders only the price when there is no Ukrainian localisation', async () => {
    const wrapper = await mountSuspended(GameCard, {
      props: {
        game: {
          ...game,
          price: {
            bestUah: 1349,
            regularUah: null,
            bestStore: 'steam',
            discountPercent: 0,
            isFree: false,
            updatedAt: '2026-09-18T09:00:00.000Z',
          },
          localisation: null,
        },
      },
    })
    expect(wrapper.find('[data-test="price"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="localisation"]').exists()).toBe(false)
  })

  it('renders only the badge when the game has Ukrainian localisation but no price', async () => {
    const wrapper = await mountSuspended(GameCard, {
      props: {
        game: { ...game, price: null, localisation: { text: true, audio: false, source: 'steam' } },
      },
    })
    expect(wrapper.find('[data-test="price"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="localisation"]').exists()).toBe(true)
  })

  it('stays the same flex column, h-full card regardless of the price line, so grid rows stay equal height', async () => {
    const withPrice = await mountSuspended(GameCard, {
      props: {
        game: {
          ...game,
          price: {
            bestUah: 1349,
            regularUah: null,
            bestStore: 'steam',
            discountPercent: 0,
            isFree: false,
            updatedAt: '2026-09-18T09:00:00.000Z',
          },
        },
      },
    })
    const without = await mountSuspended(GameCard, { props: { game } })
    expect(withPrice.get('[data-test="game-card"]').classes()).toEqual(
      without.get('[data-test="game-card"]').classes(),
    )
    expect(withPrice.get('a').classes()).toEqual(
      expect.arrayContaining(['flex', 'h-full', 'flex-col']),
    )
  })

  it('matches a browser-less HTML snapshot of a fully priced, localised card (no live browser to check against until PR 5 fills the resolvers)', async () => {
    const priced = {
      ...game,
      price: {
        bestUah: 337,
        regularUah: 1349,
        bestStore: 'steam',
        discountPercent: 75,
        isFree: false,
        updatedAt: '2026-09-18T09:00:00.000Z',
      },
      localisation: { text: true, audio: true, source: 'steam' },
    }
    const wrapper = await mountSuspended(GameCard, { props: { game: priced } })
    expect(wrapper.get('[data-test="price"]').html()).toMatchInlineSnapshot(
      `"<p data-test="price" class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm"><span class="font-numeric inline-flex items-center rounded-chip bg-sale px-1.5 py-0.5 text-xs font-semibold text-on-sale"> −75% </span><span class="font-numeric font-medium text-fg">337&nbsp;₴</span><span class="sr-only">було</span><s class="font-numeric text-fg-2">1&nbsp;349&nbsp;₴</s></p>"`,
    )
    expect(wrapper.get('[data-test="localisation"]').html()).toMatchInlineSnapshot(
      `"<span data-test="localisation" role="img" aria-label="Українська: текст і озвучка" title="Українська: текст і озвучка" class="inline-flex shrink-0 items-center gap-1 rounded-chip border border-line px-1.5 py-0.5 text-xs font-semibold text-fg-2"> UA <svg aria-hidden="true" viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M2 6h2.5l3.3-2.9c.4-.3 1-.1 1 .5v8.8c0 .6-.6.9-1 .5L4.5 10H2a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z"></path><path d="M11 5.2a3.2 3.2 0 0 1 0 5.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"></path></svg></span>"`,
    )
  })

  it('shows a text fallback without a cover', async () => {
    const wrapper = await mountSuspended(GameCard, {
      props: { game: { ...game, cover: null, screenshots: [] } },
    })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('Немає обкладинки')
  })

  it('lazy-loads the cover image by default', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    expect(wrapper.get('img').attributes('loading')).toBe('lazy')
  })

  it('eager-loads the cover image when eager is true', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game, eager: true } })
    expect(wrapper.get('img').attributes('loading')).toBe('eager')
  })

  it('renders only the cover on first paint, even when a screenshot exists', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    expect(wrapper.findAll('img')).toHaveLength(1)
  })

  it('loads the hidden preview image only after mouse hover shows intent', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    expect(wrapper.findAll('img')).toHaveLength(1)

    await wrapper.get('a').trigger('pointerenter', { pointerType: 'mouse' })

    const images = wrapper.findAll('img')
    expect(images).toHaveLength(2)
    const preview = images[1]!
    expect(preview.attributes('src')).toContain('shot.jpg')
    expect(preview.attributes('alt')).toBe('')
    expect(preview.attributes('aria-hidden')).toBe('true')
    expect(preview.attributes('loading')).toBe('lazy')
    expect(preview.attributes('width')).toBe('420')
    expect(preview.attributes('height')).toBe('236')
  })

  it('loads the hidden preview image only after keyboard focus shows intent', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    expect(wrapper.findAll('img')).toHaveLength(1)

    await wrapper.get('a').trigger('focus')

    expect(wrapper.findAll('img')).toHaveLength(2)
  })

  it('ignores a touch pointer: no preview fetch on tap', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })

    await wrapper.get('a').trigger('pointerenter', { pointerType: 'touch' })

    expect(wrapper.findAll('img')).toHaveLength(1)
  })

  it('never loads a preview when there are no screenshots, even on hover', async () => {
    const wrapper = await mountSuspended(GameCard, {
      props: { game: { ...game, screenshots: [] } },
    })

    await wrapper.get('a').trigger('pointerenter', { pointerType: 'mouse' })

    expect(wrapper.findAll('img')).toHaveLength(1)
  })

  it('stretches to the full grid-row height as a flex column, so short cards still align', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    expect(wrapper.get('[data-test="game-card"]').classes()).toContain('h-full')
    expect(wrapper.get('a').classes()).toEqual(
      expect.arrayContaining(['flex', 'h-full', 'flex-col']),
    )
  })

  it('reserves two lines for the title so covers and meta rows line up across a row', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    const title = wrapper.get('[data-test="card-title"]')
    expect(title.classes()).toEqual(expect.arrayContaining(['line-clamp-2', 'min-h-[2.75rem]']))
  })

  it('sets the title heading level to h3 by default, for use under a section h2 (GameRow)', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    expect(wrapper.get('[data-test="card-title"]').element.tagName).toBe('H3')
  })

  it('sets the title heading level to h2 when asked, for use directly under a page h1 (GameGrid)', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game, headingLevel: 2 } })
    expect(wrapper.get('[data-test="card-title"]').element.tagName).toBe('H2')
  })

  it('keeps the badge and platform icons on one non-wrapping line', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    const meta = wrapper.get('[data-test="card-title"]').element.parentElement
    const metaRow = meta?.querySelector('p:last-of-type')
    expect(metaRow).toBeTruthy()
    expect(metaRow?.className).toContain('flex-nowrap')
    expect(metaRow?.className).not.toContain('flex-wrap')
  })

  it('renders the meta block as two lines: year · platforms, then "Metacritic 82"', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    const meta = wrapper.get('[data-test="card-title"]').element.parentElement!
    // The first line (year · platforms) is a `<div>`, not a `<p>`: `PlatformIcons` in
    // `responsive` mode renders `<ul>` elements, which HTML forbids inside `<p>` — a browser
    // parsing SSR'd HTML auto-closes an open `<p>` at the first `<ul>` it meets (even nested a
    // level or two deeper) and hoists the rest out as following siblings, corrupting the DOM
    // before hydration ever runs (see the comment above this row in GameCard.vue).
    const lines = meta.querySelectorAll(':scope > div.mt-auto > :is(div, p)')
    expect(lines).toHaveLength(2)
    expect(lines[0]!.tagName).toBe('DIV')
    expect(lines[1]!.tagName).toBe('P')
    expect(lines[0]!.textContent).toContain('2015')
    expect(lines[0]!.textContent).toContain('ПК')
    expect(lines[1]!.textContent).toContain('Metacritic')
    expect(lines[1]!.textContent).toContain('92')
  })

  it('renders PlatformIcons in responsive (container-query) mode in the card context', async () => {
    const wrapper = await mountSuspended(GameCard, {
      props: {
        game: {
          ...game,
          platformFamilies: ['PC', 'PLAYSTATION', 'XBOX', 'NINTENDO'] as const,
        },
      },
    })
    expect(wrapper.findComponent(PlatformIcons).props('responsive')).toBe(true)
  })

  it('establishes a container-query context around the meta block, so the platform row can adapt without JS', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    const meta = wrapper.get('[data-test="card-title"]').element.parentElement!
    const container = meta.querySelector(':scope > div.mt-auto')
    expect(container?.className).toContain('@container')
  })

  describe('layout="list"', () => {
    it('lays out horizontally at >= 640px, with the cover at a fixed 220px width', async () => {
      const wrapper = await mountSuspended(GameCard, { props: { game, layout: 'list' } })
      const link = wrapper.get('a')
      expect(link.classes()).toEqual(expect.arrayContaining(['flex-col', 'sm:flex-row']))

      const cover = wrapper.get('[data-test="game-card"] img').element.parentElement!
      expect(cover.className).toContain('sm:w-[220px]')
      expect(cover.className).toContain('w-full')
    })

    it('asks for its own slot width, not the grid layout, keeping explicit width/height', async () => {
      const grid = await mountSuspended(GameCard, { props: { game } })
      const list = await mountSuspended(GameCard, { props: { game, layout: 'list' } })
      // The exact emitted `sizes`/`srcset` of both layouts is asserted in imageSizes.test.ts.
      // Here: the list cover is full-width on phones (where grid shows two columns) and a fixed
      // 220px box from 640px up, so the two layouts must not share one `sizes` string.
      const gridSizes = grid.get('img').attributes('sizes')!
      const listSizes = list.get('img').attributes('sizes')!
      expect(listSizes).not.toBe(gridSizes)
      expect(listSizes).toBe('(max-width: 639px) 100vw, 220px')

      const cover = list.get('img')
      expect(cover.attributes('width')).toBe('420')
      expect(cover.attributes('height')).toBe('236')
    })

    it('keeps the eager/lazy rule and the hover/focus preview behaviour unchanged', async () => {
      const eager = await mountSuspended(GameCard, { props: { game, layout: 'list', eager: true } })
      expect(eager.get('img').attributes('loading')).toBe('eager')

      const wrapper = await mountSuspended(GameCard, { props: { game, layout: 'list' } })
      expect(wrapper.findAll('img')).toHaveLength(1)
      await wrapper.get('a').trigger('pointerenter', { pointerType: 'mouse' })
      const images = wrapper.findAll('img')
      expect(images).toHaveLength(2)
      expect(images[1]!.attributes('width')).toBe('420')
      expect(images[1]!.attributes('height')).toBe('236')
    })

    it('defaults to "grid": no sm:flex-row and no fixed cover width', async () => {
      const wrapper = await mountSuspended(GameCard, { props: { game } })
      expect(wrapper.get('a').classes()).not.toContain('sm:flex-row')
      const cover = wrapper.get('img').element.parentElement!
      expect(cover.className).not.toContain('sm:w-[220px]')
    })
  })
})
