import { describe, expect, it } from 'vitest'
import { filterLabels, type FilterLabelContext } from '~/utils/filterLabels'

/**
 * The words for an active filter, shared by the chip row and the catalog's meta description. A
 * fake `t` that echoes its key and arguments makes the mapping itself visible, independent of the
 * locale files.
 */
const context: FilterLabelContext = {
  t: (key, named) => (named ? `${key}(${Object.values(named).join(',')})` : key),
  formatUah: (value) => `${value} ₴`,
  genres: [{ slug: 'rpg', name: 'RPG' }],
}

describe('filterLabels', () => {
  it('has nothing to say about an empty filter', () => {
    expect(filterLabels({}, context)).toEqual([])
  })

  it('names genres from the list, platforms and stores from their options', () => {
    const labels = filterLabels(
      { genres: ['rpg', 'unknown-genre'], platforms: [4], stores: ['steam'] },
      context,
    )
    expect(labels.map((label) => label.label)).toEqual(['RPG', 'unknown-genre', 'PC', 'Steam'])
  })

  it('removes one value of a list and clears the key with the last one', () => {
    const [first] = filterLabels({ genres: ['rpg', 'action'] }, context)
    expect(first!.patch).toEqual({ genres: ['action'] })
    const [only] = filterLabels({ genres: ['rpg'] }, context)
    expect(only!.patch).toEqual({ genres: undefined })
  })

  it('keeps the field each label stands for, so an ignored filter can be matched to it', () => {
    const labels = filterLabels({ priceMaxUah: 300, madeInUkraine: true }, context)
    expect(labels.map((label) => [label.field, label.label])).toEqual([
      ['priceMaxUah', 'filters.priceUpTo(300 ₴)'],
      ['madeInUkraine', 'filters.madeInUkraine'],
    ])
  })

  it('reads a bare number in prose with the name of what it measures', () => {
    // "75+" is clear on a chip under the Metacritic section; in a sentence it is not.
    const labels = filterLabels({ metacriticMin: 75, yearFrom: 2010, yearTo: 2015 }, context)
    expect(labels.map((label) => label.label)).toEqual(['2010–2015', 'filters.metacriticMin(75)'])
    expect(labels.map((label) => label.prose)).toEqual([
      'filters.year: 2010–2015',
      'filters.metacritic filters.metacriticMin(75)',
    ])
  })

  it('reads every other label in prose exactly as it reads on its chip', () => {
    const labels = filterLabels(
      { ukrainianLocalisation: 'AUDIO', free: true, search: 'witcher' },
      context,
    )
    for (const label of labels) expect(label.prose).toBe(label.label)
  })

  it('lists the labels in the order the chip row shows them', () => {
    const labels = filterLabels(
      { madeInUkraine: true, search: 'x', platforms: [4], ukrainianLocalisation: 'TEXT' },
      context,
    )
    expect(labels.map((label) => label.key)).toEqual([
      'search',
      'platform:4',
      'ukrainianLocalisation',
      'madeInUkraine',
    ])
  })
})
