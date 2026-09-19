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
