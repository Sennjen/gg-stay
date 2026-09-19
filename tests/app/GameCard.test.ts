import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import GameCard from '~/components/GameCard.vue'
import MetacriticBadge from '~/components/MetacriticBadge.vue'
import PlatformIcons from '~/components/PlatformIcons.vue'

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
  price: null,
  localisation: null,
  madeInUkraine: false,
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
    const lines = meta.querySelectorAll(':scope > div.mt-auto > p')
    expect(lines).toHaveLength(2)
    expect(lines[0]!.textContent).toContain('2015')
    expect(lines[0]!.textContent).toContain('ПК')
    expect(lines[1]!.textContent).toContain('Metacritic')
    expect(lines[1]!.textContent).toContain('92')
  })

  it('passes the 1/2/3-label container-query variants to PlatformIcons in the card context', async () => {
    const wrapper = await mountSuspended(GameCard, {
      props: {
        game: {
          ...game,
          platformFamilies: ['PC', 'PLAYSTATION', 'XBOX', 'NINTENDO'] as const,
        },
      },
    })
    expect(wrapper.findComponent(PlatformIcons).props('variants')).toEqual([1, 2, 3])
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

    it('asks for a narrower image than the grid layout, keeping explicit width/height', async () => {
      const grid = await mountSuspended(GameCard, { props: { game } })
      const list = await mountSuspended(GameCard, { props: { game, layout: 'list' } })
      // `NuxtImg` resolves its own `sizes` attribute from the `sizes` prop; what matters here is
      // that list asks for a narrower rendered size than grid, not the raw HTML sizes syntax.
      const gridSizes = grid.get('img').attributes('sizes')!
      const listSizes = list.get('img').attributes('sizes')!
      expect(listSizes).not.toBe(gridSizes)
      expect(listSizes).toContain('220')
      expect(gridSizes).toContain('420')

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
