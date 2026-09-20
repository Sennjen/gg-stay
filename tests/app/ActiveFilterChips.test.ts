import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ActiveFilterChips from '~/components/ActiveFilterChips.vue'

const genres = [{ slug: 'rpg', name: 'RPG' }]

describe('ActiveFilterChips', () => {
  it('renders nothing when there are no active filters', async () => {
    const wrapper = await mountSuspended(ActiveFilterChips, { props: { filter: {}, genres } })
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('resolves labels from the genre list, platform options and translations', async () => {
    const wrapper = await mountSuspended(ActiveFilterChips, {
      props: {
        filter: { genres: ['rpg'], platforms: [187], playtime: 'LONG', ageRating: ['PEGI16'] },
        genres,
      },
    })
    const text = wrapper.text()
    expect(text).toContain('RPG')
    expect(text).toContain('PlayStation 5')
    expect(text).toContain('PEGI 16')
  })

  it('removing a chip emits change with that value removed', async () => {
    const wrapper = await mountSuspended(ActiveFilterChips, {
      props: {
        filter: { genres: ['rpg', 'action'] },
        genres: [...genres, { slug: 'action', name: 'Action' }],
      },
    })
    const removeButtons = wrapper.findAll('button[aria-label]')
    await removeButtons[0]!.trigger('click')
    expect(wrapper.emitted('change')![0]).toEqual([{ genres: ['action'] }])
  })

  it('removing the last value in a list clears the key entirely', async () => {
    const wrapper = await mountSuspended(ActiveFilterChips, {
      props: { filter: { genres: ['rpg'] }, genres },
    })
    await wrapper.get('button[aria-label]').trigger('click')
    expect(wrapper.emitted('change')![0]).toEqual([{ genres: undefined }])
  })

  it('"reset all" emits clear', async () => {
    const wrapper = await mountSuspended(ActiveFilterChips, {
      props: { filter: { genres: ['rpg'] }, genres },
    })
    const buttons = wrapper.findAll('button')
    await buttons[buttons.length - 1]!.trigger('click')
    expect(wrapper.emitted('clear')).toHaveLength(1)
  })

  it('shows the year range as one chip and removes both bounds together', async () => {
    const wrapper = await mountSuspended(ActiveFilterChips, {
      props: { filter: { yearFrom: 2010, yearTo: 2020 }, genres: [] },
    })
    expect(wrapper.text()).toContain('2010–2020')
    await wrapper.get('button[aria-label]').trigger('click')
    expect(wrapper.emitted('change')![0]).toEqual([{ yearFrom: undefined, yearTo: undefined }])
  })

  describe('one-sided year chips keep the word out of the mono face', () => {
    it('uk: "yearFrom" only', async () => {
      const wrapper = await mountSuspended(ActiveFilterChips, {
        props: { filter: { yearFrom: 2010 }, genres: [] },
      })
      const mono = wrapper.get('.font-numeric')
      expect(mono.text()).toBe('2010')
      expect(wrapper.text()).toContain('від 2010')
      expect(wrapper.text().replace(mono.text(), '').trim()).not.toBe('')
    })

    it('uk: "yearTo" only', async () => {
      const wrapper = await mountSuspended(ActiveFilterChips, {
        props: { filter: { yearTo: 2015 }, genres: [] },
      })
      const mono = wrapper.get('.font-numeric')
      expect(mono.text()).toBe('2015')
      expect(wrapper.text()).toContain('до 2015')
    })

    it('en: "yearFrom" only', async () => {
      const wrapper = await mountSuspended(ActiveFilterChips, {
        props: { filter: { yearFrom: 2010 }, genres: [] },
        route: '/en/games',
      })
      const mono = wrapper.get('.font-numeric')
      expect(mono.text()).toBe('2010')
      expect(wrapper.text()).toContain('from 2010')
    })

    it('en: "yearTo" only', async () => {
      const wrapper = await mountSuspended(ActiveFilterChips, {
        props: { filter: { yearTo: 2015 }, genres: [] },
        route: '/en/games',
      })
      const mono = wrapper.get('.font-numeric')
      expect(mono.text()).toBe('2015')
      expect(wrapper.text()).toContain('up to 2015')
    })
  })
})

describe('ActiveFilterChips: the index filters', () => {
  it('renders one removable chip per index filter', async () => {
    const wrapper = await mountSuspended(ActiveFilterChips, {
      props: {
        filter: {
          free: true,
          priceMaxUah: 1000,
          onSaleMinPercent: 50,
          ukrainianLocalisation: 'AUDIO',
        },
        genres: [],
      },
    })
    const text = wrapper.text()
    expect(text).toContain('Безкоштовно')
    expect(text).toContain('до 1 000 ₴')
    expect(text).toContain('від 50 %')
    expect(text).toContain('Українська: озвучка')

    const removes = wrapper.findAll('button[aria-label]')
    expect(removes).toHaveLength(4)
    await removes[0]!.trigger('click')
    expect(wrapper.emitted('change')![0]).toEqual([{ free: undefined }])
    await removes[1]!.trigger('click')
    expect(wrapper.emitted('change')![1]).toEqual([{ priceMaxUah: undefined }])
    await removes[2]!.trigger('click')
    expect(wrapper.emitted('change')![2]).toEqual([{ onSaleMinPercent: undefined }])
    await removes[3]!.trigger('click')
    expect(wrapper.emitted('change')![3]).toEqual([{ ukrainianLocalisation: undefined }])
  })

  it('names each localisation level rather than making the visitor guess', async () => {
    for (const [level, label] of [
      ['ANY', 'Українська: будь-яка'],
      ['TEXT', 'Українська: текст'],
      ['AUDIO', 'Українська: озвучка'],
    ] as const) {
      const wrapper = await mountSuspended(ActiveFilterChips, {
        props: { filter: { ukrainianLocalisation: level }, genres: [] },
      })
      expect(wrapper.text()).toContain(label)
    }
  })

  it('keeps the bare numbers in the mono face and the words out of it', async () => {
    const wrapper = await mountSuspended(ActiveFilterChips, {
      props: { filter: { onSaleMinPercent: 75 }, genres: [] },
    })
    expect(wrapper.get('.font-numeric').text()).toBe('75')
    expect(wrapper.text()).toContain('від 75 %')
  })

  it('strikes an ignored filter through, explains it in words, and still removes it', async () => {
    const wrapper = await mountSuspended(ActiveFilterChips, {
      props: {
        filter: { priceMaxUah: 300, ukrainianLocalisation: 'TEXT' },
        genres: [],
        ignored: ['priceMaxUah'],
        indexStale: true,
      },
    })
    const struck = wrapper.findAll('[data-test="ignored-chip"]')
    expect(struck).toHaveLength(1)
    expect(struck[0]!.find('s').exists()).toBe(true)
    // The explanation is visible text, not a title attribute: nothing here may depend on hover.
    expect(struck[0]!.text()).toContain('не застосовано: ціни тимчасово не оновлюються')

    await struck[0]!.get('button[aria-label]').trigger('click')
    expect(wrapper.emitted('change')![0]).toEqual([{ priceMaxUah: undefined }])
  })

  it('tells a stale index apart from one that is not answering', async () => {
    const down = await mountSuspended(ActiveFilterChips, {
      props: { filter: { free: true }, genres: [], ignored: ['free'], indexStale: false },
    })
    expect(down.get('[data-test="ignored-chip"]').text()).toContain(
      'не застосовано: дані про ціни зараз недоступні',
    )
  })

  it('gives every index filter the index reason, whichever one it is', async () => {
    // The reason is derived from `INDEX_FILTER_FIELDS`, not from a second hard-coded list, so a
    // localisation filter dropped by a silent index is explained as an index problem too.
    for (const [filter, field] of [
      [{ free: true }, 'free'],
      [{ priceMaxUah: 300 }, 'priceMaxUah'],
      [{ onSaleMinPercent: 50 }, 'onSaleMinPercent'],
      [{ ukrainianLocalisation: 'TEXT' }, 'ukrainianLocalisation'],
    ] as const) {
      const wrapper = await mountSuspended(ActiveFilterChips, {
        props: { filter, genres: [], ignored: [field], indexStale: true },
      })
      expect(wrapper.get('[data-test="ignored-chip"]').text()).toContain(
        'не застосовано: ціни тимчасово не оновлюються',
      )
    }
  })

  it('explains a RAWG-only filter that lost to the index in its own words', async () => {
    const wrapper = await mountSuspended(ActiveFilterChips, {
      props: {
        filter: { developers: ['cd-projekt-red'], free: true },
        genres: [],
        ignored: ['developers'],
      },
    })
    expect(wrapper.get('[data-test="ignored-chip"]').text()).toContain(
      'не застосовано: не працює разом із фільтрами ціни',
    )
  })

  it('leaves the chips alone when nothing was ignored', async () => {
    const wrapper = await mountSuspended(ActiveFilterChips, {
      props: { filter: { free: true }, genres: [], ignored: [] },
    })
    expect(wrapper.find('[data-test="ignored-chip"]').exists()).toBe(false)
    expect(wrapper.find('s').exists()).toBe(false)
  })
})
