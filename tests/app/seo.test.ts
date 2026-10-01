import { describe, expect, it } from 'vitest'
import {
  INDEXABLE,
  NOT_INDEXABLE,
  catalogRobots,
  metaDescription,
  trimDescription,
  withSiteName,
} from '~/utils/seo'

describe('withSiteName', () => {
  it('ends every page title with the site name', () => {
    expect(withSiteName('Каталог ігор')).toBe('Каталог ігор — GG Stay')
  })
})

describe('trimDescription', () => {
  it('leaves a short description alone, whitespace collapsed', () => {
    expect(trimDescription('  Ігри   для\nгравця. ')).toBe('Ігри для гравця.')
  })

  it('cuts a long one on a word boundary, within the limit, and marks the cut', () => {
    const text = `${'слово '.repeat(40)}кінець`
    const trimmed = trimDescription(text)
    expect(trimmed.length).toBeLessThanOrEqual(160)
    expect(trimmed.endsWith('слово…')).toBe(true)
    expect(text.startsWith(trimmed.slice(0, -1))).toBe(true)
  })

  it('never leaves a dangling comma or dash before the ellipsis', () => {
    const text = `${'а'.repeat(150)}, ${'б'.repeat(30)}`
    expect(trimDescription(text)).toBe(`${'а'.repeat(150)}…`)
    const dashed = `${'а'.repeat(150)} — ${'б'.repeat(30)}`
    expect(trimDescription(dashed)).toBe(`${'а'.repeat(150)}…`)
  })

  it('cuts mid-word only when there is no word boundary worth keeping', () => {
    const trimmed = trimDescription('ж'.repeat(400))
    expect(trimmed).toBe(`${'ж'.repeat(159)}…`)
  })

  it('takes another limit when asked', () => {
    expect(trimDescription('one two three four', 10)).toBe('one two…')
  })
})

describe('metaDescription', () => {
  it('skips a heading-like first line the store put above the text', () => {
    // Steam's Ukrainian descriptions open with its own "About the game" heading.
    expect(metaDescription('Про гру\nВи — Ґеральт із Рівії, відьмак.\nДруге речення.')).toBe(
      'Ви — Ґеральт із Рівії, відьмак. Друге речення.',
    )
  })

  it('keeps a first line that is a sentence', () => {
    expect(metaDescription('Коротко.\nДалі.')).toBe('Коротко. Далі.')
  })

  it('keeps a short text that is nothing but its heading', () => {
    expect(metaDescription('Про гру')).toBe('Про гру')
  })

  it('trims to the description limit', () => {
    expect(metaDescription(`Заголовок\n${'слово '.repeat(60)}`).length).toBeLessThanOrEqual(160)
  })

  it('answers nothing for a missing or blank text', () => {
    expect(metaDescription(null)).toBe('')
    expect(metaDescription(' \n ')).toBe('')
  })
})

describe('catalogRobots', () => {
  it('lets the plain first page be indexed', () => {
    expect(catalogRobots({ filtered: false, page: 1 })).toBe(INDEXABLE)
  })

  it('keeps any filtered page and any page past the first out of the index, links followed', () => {
    expect(catalogRobots({ filtered: true, page: 1 })).toBe(NOT_INDEXABLE)
    expect(catalogRobots({ filtered: false, page: 2 })).toBe(NOT_INDEXABLE)
    expect(NOT_INDEXABLE).toBe('noindex, follow')
  })

  it('allows large image previews wherever it allows indexing', () => {
    expect(INDEXABLE).toBe('index, follow, max-image-preview:large')
  })
})
