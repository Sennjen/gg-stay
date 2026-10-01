import { describe, expect, it } from 'vitest'
import {
  INDEXABLE,
  NOT_INDEXABLE,
  catalogRobots,
  metaDescription,
  robotsFor,
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

  it('never cuts a character in half', () => {
    // An emoji is two UTF-16 code units; a cut between them leaves a lone surrogate.
    const trimmed = trimDescription(`${'а'.repeat(158)}🎮🎮🎮`)
    expect(trimmed).toBe(`${'а'.repeat(158)}🎮…`)
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

  it('skips only the first line: a short line further down is part of the text', () => {
    expect(metaDescription('Про гру\nКлючові риси\nВідкритий світ\nДовга історія.')).toBe(
      'Ключові риси Відкритий світ Довга історія.',
    )
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
  const plain = { filtered: false, sorted: false, page: 1 }

  it('lets the plain first page be indexed, with large image previews', () => {
    expect(catalogRobots(plain)).toBe('index, follow, max-image-preview:large')
  })

  it('keeps every other view of the catalog out of the index, links still followed', () => {
    for (const view of [
      { ...plain, filtered: true },
      { ...plain, page: 2 },
      // A different order of the same games is another view of the first page, not a page.
      { ...plain, sorted: true },
    ]) {
      expect(catalogRobots(view)).toBe('noindex, follow')
    }
  })
})

describe('robotsFor', () => {
  it('passes a page’s own rule through on a deployment that may be indexed', () => {
    expect(robotsFor(INDEXABLE, false)).toBe(INDEXABLE)
    expect(robotsFor(NOT_INDEXABLE, false)).toBe(NOT_INDEXABLE)
  })

  it('keeps every page of a preview deployment out of the index, whatever the page says', () => {
    expect(robotsFor(INDEXABLE, true)).toBe('noindex, nofollow')
    expect(robotsFor('noindex', true)).toBe('noindex, nofollow')
  })
})
