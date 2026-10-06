import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import GegeMascot from '~/components/GegeMascot.vue'
import source from '~/components/GegeMascot.vue?raw'

const MOODS = ['idle', 'peek', 'thinking', 'happy'] as const

describe('GegeMascot', () => {
  it('is a decorative inline SVG on a crisp pixel grid', async () => {
    const wrapper = await mountSuspended(GegeMascot)
    const svg = wrapper.get('svg')
    expect(svg.attributes('aria-hidden')).toBe('true')
    expect(svg.attributes('focusable')).toBe('false')
    expect(svg.attributes('shape-rendering')).toBe('crispEdges')
    expect(svg.attributes('viewBox')).toBe('0 0 20 13')
    expect(wrapper.find('title').exists()).toBe(false)
    expect(wrapper.find('image').exists()).toBe(false)
  })

  it('defaults to the idle mood, moving', async () => {
    const wrapper = await mountSuspended(GegeMascot)
    expect(wrapper.attributes('data-mood')).toBe('idle')
    expect(wrapper.classes()).toEqual(expect.arrayContaining(['gege--idle', 'gege--animated']))
  })

  it.each([
    [20, 13],
    [44, 29],
    [96, 62],
    [160, 104],
  ])('is %i px wide and follows the grid ratio to %i px tall', async (size, height) => {
    const wrapper = await mountSuspended(GegeMascot, { props: { size } })
    expect(wrapper.attributes('width')).toBe(String(size))
    expect(wrapper.attributes('height')).toBe(String(height))
  })

  it('draws only with design tokens: no colour is written into the markup', async () => {
    for (const mood of MOODS) {
      const wrapper = await mountSuspended(GegeMascot, { props: { mood } })
      expect(wrapper.html()).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|fill="/i)
    }
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i)
  })

  it.each(MOODS)('names the %s mood on the root element', async (mood) => {
    const wrapper = await mountSuspended(GegeMascot, { props: { mood } })
    expect(wrapper.attributes('data-mood')).toBe(mood)
    expect(wrapper.classes()).toContain(`gege--${mood}`)
  })

  describe('static poses', () => {
    it('idle: open eyes, a smile, and lids that only the blink shows', async () => {
      const wrapper = await mountSuspended(GegeMascot, { props: { mood: 'idle', animated: false } })
      expect(wrapper.find('[data-eyes="open"]').exists()).toBe(true)
      expect(wrapper.find('[data-mouth="smile"]').exists()).toBe(true)
      expect(wrapper.find('.gege-blink').exists()).toBe(true)
      expect(wrapper.find('.gege-buttons--thinking').exists()).toBe(false)
    })

    it('peek: the idle face, tilted by its own class, with no blink', async () => {
      const wrapper = await mountSuspended(GegeMascot, { props: { mood: 'peek', animated: false } })
      expect(wrapper.find('[data-eyes="open"]').exists()).toBe(true)
      expect(wrapper.find('.gege-blink').exists()).toBe(false)
      expect(source).toMatch(/\.gege--peek \{\s*transform: rotate\(-8deg\);/)
    })

    it('thinking: narrowed eyes and face buttons marked to light up', async () => {
      const wrapper = await mountSuspended(GegeMascot, {
        props: { mood: 'thinking', animated: false },
      })
      expect(wrapper.find('[data-eyes="narrowed"]').exists()).toBe(true)
      expect(wrapper.find('[data-eyes="open"]').exists()).toBe(false)
      expect(wrapper.findAll('.gege-buttons--thinking .gege-button')).toHaveLength(4)
      // Standing still, the first button stays lit so the pose is not the idle one.
      expect(source).toMatch(
        /\.gege-buttons--thinking \.gege-button--1 \{\s*fill: var\(--color-signal\);/,
      )
    })

    it('happy: eyes as arcs and an open mouth', async () => {
      const wrapper = await mountSuspended(GegeMascot, {
        props: { mood: 'happy', animated: false },
      })
      expect(wrapper.find('[data-eyes="arcs"]').exists()).toBe(true)
      expect(wrapper.find('[data-mouth="happy"]').exists()).toBe(true)
    })

    it('always has a d-pad and four face buttons', async () => {
      for (const mood of MOODS) {
        const wrapper = await mountSuspended(GegeMascot, { props: { mood } })
        expect(wrapper.findAll('.gege-button')).toHaveLength(4)
      }
    })
  })

  describe('motion', () => {
    it('is off entirely with animated=false: the pose stays, the motion class goes', async () => {
      for (const mood of MOODS) {
        const wrapper = await mountSuspended(GegeMascot, { props: { mood, animated: false } })
        expect(wrapper.classes()).not.toContain('gege--animated')
        expect(wrapper.classes()).toContain(`gege--${mood}`)
      }
    })

    // The component test environment does not evaluate stylesheets, so the two rules the design
    // depends on are pinned on the source: nothing animates without the `gege--animated` class,
    // and reduced motion removes every animation rather than only shortening it.
    it('animates only under the gege--animated class', () => {
      const style = source.slice(source.indexOf('<style scoped>'))
      const rules = [...style.matchAll(/([^{}]+)\{[^{}]*\banimation(?:-delay)?:[^{}]*\}/g)]
        .map((match) => match[1]!.trim())
        .filter((selector) => !selector.includes('.gege *'))
      expect(rules.length).toBeGreaterThanOrEqual(5)
      for (const selector of rules) expect(selector).toContain('.gege--animated')
    })

    it('stops every loop under prefers-reduced-motion: reduce', () => {
      expect(source).toMatch(
        /@media \(prefers-reduced-motion: reduce\) \{\s*\.gege,\s*\.gege \* \{\s*animation: none !important;/,
      )
    })

    it('moves with CSS alone: the component holds no timers and no script-driven animation', () => {
      expect(source).not.toMatch(/setTimeout|setInterval|requestAnimationFrame|\.animate\(/)
    })
  })
})
