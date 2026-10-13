import { describe, expect, it } from 'vitest'
import {
  comparableTitle,
  EDITION_WORDS,
  EDITION_WORDS_ONLY_AFTER,
  gameReleasedAt,
  isReleasedInTime,
  isSameTitle,
  matchComparableTitle,
  matchTitle,
  RELEASE_TOLERANCE_MS,
} from '../../../scripts/index/titleMatch'

/**
 * The one judgement the job makes from a title: whether what a store calls a product is the game
 * the index holds. Every pair below is a real one — a game's name at RAWG beside a title GOG or
 * the Microsoft Store gave for Ukraine on 2026-10-13 — or is written to stand for a kind of them.
 *
 * Characters that look like another are written as escapes: a test about a dash nobody can tell
 * from a hyphen must at least say which of them it is.
 */

describe('comparableTitle', () => {
  it('drops the trademark signs, and does not turn one into letters', () => {
    expect(comparableTitle('Batman™: Arkham Knight')).toBe('batman: arkham knight')
    expect(comparableTitle('Prey®: Digital Deluxe Edition')).toBe('prey: digital deluxe edition')
    expect(comparableTitle('© LIMBO')).toBe('limbo')
    // NFKC alone would spell the sign out: "batmantm".
    expect('Batman™'.normalize('NFKC')).toBe('BatmanTM')
    expect(comparableTitle('Batman™')).toBe('batman')
  })

  it('folds the forms Unicode calls compatible', () => {
    // A no-break space, a fullwidth letter and digit, a Roman numeral in one character.
    expect(comparableTitle('Halo Infinite')).toBe('halo infinite')
    expect(comparableTitle('ＤＯＯＭ ３')).toBe('doom 3')
    expect(comparableTitle('Final Fantasy Ⅶ')).toBe('final fantasy vii')
  })

  it('reads every dash as a hyphen', () => {
    for (const dash of ['‐', '‑', '‒', '–', '—', '―', '−']) {
      expect(comparableTitle(`Spider${dash}Man`)).toBe('spider-man')
    }
  })

  it('reads every apostrophe as the plain one', () => {
    for (const mark of ['‘', '’', '‛', 'ʹ', 'ʼ', '′', '`', '´']) {
      expect(comparableTitle(`Assassin${mark}s Creed`)).toBe("assassin's creed")
    }
    expect(comparableTitle('Assassin＇s Creed')).toBe("assassin's creed")
  })

  it('drops case, collapses whitespace and trims', () => {
    expect(comparableTitle('  METRO   EXODUS \n')).toBe('metro exodus')
    expect(comparableTitle('The Witcher 3:\tWild Hunt')).toBe('the witcher 3: wild hunt')
  })

  it('changes nothing else', () => {
    // Punctuation, accents and words are all the title's own.
    expect(comparableTitle('Batman: Arkham Knight')).not.toBe(
      comparableTitle('Batman - Arkham Knight'),
    )
    expect(comparableTitle('Pokémon')).not.toBe(comparableTitle('Pokemon'))
    expect(comparableTitle('DOOM Eternal Standard Edition (PC)')).toBe(
      'doom eternal standard edition (pc)',
    )
  })
})

describe('matchTitle: the same title', () => {
  it.each([
    ['Resident Evil Village', 'Resident Evil Village'],
    ['Terraria', 'Terraria'],
    ['Limbo', 'LIMBO'],
    ['Batman: Arkham Knight', 'Batman™: Arkham Knight'],
    ['Prey', 'Prey®'],
    ["Assassin's Creed Odyssey", 'Assassin’s Creed® Odyssey'],
    ['Spider-Man', 'Spider–Man'],
    ['Halo Infinite', ' Halo  Infinite '],
  ])('%j is %j', (name, title) => {
    expect(matchTitle(name, title)).toBe('name')
    expect(isSameTitle(name, title)).toBe(true)
    // It is a comparison of two titles: neither side is the one that is folded.
    expect(isSameTitle(title, name)).toBe(true)
  })

  it.each([
    // The two pairs the ruling names.
    ['DOOM', 'DOOM Eternal Standard Edition (PC)'],
    ['Grand Theft Auto V', 'Grand Theft Auto V Enhanced (PC)'],
    ['Batman: Arkham Knight', 'Batman - Arkham Knight'],
    ['Resident Evil Village', 'Resident Evil Village Gold Edition'],
    ['Microsoft Flight Simulator: Standard Edition', 'Microsoft Flight Simulator (2020)'],
    ['Pokémon', 'Pokemon'],
    ['Prey', 'Pray'],
  ])('%j is not %j', (name, title) => {
    expect(isSameTitle(name, title)).toBe(false)
    expect(matchTitle(name, title)).not.toBe('name')
  })

  it('finds nothing in a name or a title that is not there', () => {
    expect(matchTitle('', '')).toBeNull()
    expect(matchTitle('™', '®')).toBeNull()
    expect(matchTitle('  ', 'Prey')).toBeNull()
    expect(matchTitle('Prey', null)).toBeNull()
    expect(matchTitle(undefined, 'Prey')).toBeNull()
    expect(isSameTitle(null, null)).toBe(false)
  })
})

describe('matchTitle: the same game under an edition’s name', () => {
  it.each([
    // The pairs the ruling names.
    ['DOOM Eternal', 'DOOM Eternal Standard Edition (PC)'],
    ['Grand Theft Auto V', 'Grand Theft Auto V Enhanced (PC)'],
    ['The Witcher 3: Wild Hunt', 'The Witcher 3: Wild Hunt - Complete Edition'],
    // As GOG's catalog and the Microsoft Store wrote others on 2026-10-13.
    ['The Witcher 3: Wild Hunt', 'The Witcher 3: Wild Hunt — Remastered'],
    ['The Witcher 3: Wild Hunt', 'The Witcher 3: Wild Hunt — Game of the Year Edition'],
    ['Resident Evil Village', 'Resident Evil Village Gold Edition'],
    ["Assassin's Creed Odyssey", "Assassin's Creed Odyssey - Ultimate Edition"],
    ["Assassin's Creed Odyssey", "Assassin's Creed Odyssey - Gold Edition"],
    // One for each word of the list that has none above.
    ['Divinity: Original Sin', 'Divinity: Original Sin - Enhanced Edition'],
    ['Dishonored', 'Dishonored: Definitive Edition'],
    ['Borderlands 2', 'Borderlands 2 GOTY'],
    ['Fable', 'Fable Anniversary'],
    ['Deadly Premonition', 'Deadly Premonition: Director’s Cut'],
    ['Gears of War', 'Gears of War: Ultimate Edition for Windows 10'],
    ['Forza Horizon 4', 'Forza Horizon 4 for Windows'],
    ['Grand Theft Auto V', 'Grand Theft Auto V (Xbox Series X|S)'],
    ['Grand Theft Auto V', 'Grand Theft Auto V (Xbox One & Xbox Series X|S)'],
    ['FIFA 23', 'FIFA 23 Standard Edition Xbox One'],
    ['FIFA 23', 'FIFA 23 for Xbox Series X/S'],
    ['FIFA 23', 'FIFA 23 Xbox Series S'],
    ['Hades', 'Hades: The Complete Edition and the Game of the Year'],
  ])('%j is sold as %j', (name, title) => {
    expect(matchTitle(name, title)).toBe('edition')
  })

  it.each([
    // The pairs the ruling names.
    ['DOOM', 'DOOM Eternal Standard Edition (PC)'],
    ['DOOM', 'DOOM Eternal'],
    ['Borderlands', 'Borderlands 2'],
    ['Prey', 'Prey: Mooncrash'],
    // The words left off the list on purpose: the game with, or for, something else.
    ['DOOM Eternal', 'DOOM Eternal Deluxe Edition (PC)'],
    ['Prey', 'Prey®: Digital Deluxe Edition'],
    ['DOOM: The Dark Ages', 'DOOM: The Dark Ages Premium Edition'],
    ['DOOM: The Dark Ages', 'DOOM: The Dark Ages Premium Upgrade'],
    ['Cyberpunk 2077', 'Cyberpunk 2077 & Phantom Liberty Bundle'],
    ['DOOM Eternal', 'DOOM Eternal - Rip and Tear Pack (PC)'],
    ['Borderlands 3', 'Borderlands 3 Season Pass'],
    // A subtitle, another game's name, another language.
    ['DOOM', 'DOOM: The Dark Ages'],
    ['DOOM', 'DOOM + DOOM II'],
    ['DOOM', 'DOOM 64'],
    ['Grand Theft Auto V', 'Grand Theft Auto V Legacy (PC)'],
    ['Grand Theft Auto V', 'Grand Theft Auto V Enhanced (ПК) і комплект'],
    ['Mass Effect', 'Mass Effect Legendary Edition'],
    ['Metro 2033', 'Metro 2033 Redux'],
    ['Halo', 'Halo: The Master Chief Collection'],
    // A number, however it is written.
    ['Mafia', 'Mafia II'],
    ['FIFA', 'FIFA 23'],
    ['Rise of the Tomb Raider', 'Rise of the Tomb Raider: 20 Year Celebration'],
    ['Windows', 'Windows 10'],
  ])('%j is not %j', (name, title) => {
    expect(matchTitle(name, title)).toBeNull()
  })

  it('takes a phrase of the list whole, and no word out of one', () => {
    expect(matchTitle('Prey', 'Prey Game of the Year')).toBe('edition')
    expect(matchTitle('Prey', 'Prey Game')).toBeNull()
    expect(matchTitle('Prey', 'Prey of the Year')).toBeNull()
    expect(matchTitle('Prey', "Prey Director's Cut")).toBe('edition')
    expect(matchTitle('Prey', 'Prey Cut')).toBeNull()
    expect(matchTitle('Prey', 'Prey for Windows 10')).toBe('edition')
    // The digit is on the list only as the end of that phrase.
    expect(matchTitle('Prey', 'Prey 10')).toBeNull()
    expect(matchTitle('Prey', 'Prey Windows 11')).toBeNull()
  })

  it('reads a console’s letter as one only after the word that makes it one', () => {
    expect(EDITION_WORDS_ONLY_AFTER).toEqual({
      one: ['xbox'],
      x: ['series'],
      s: ['series', 'x'],
      'x|s': ['series'],
    })
    // The tenth game of a series, a number spelled out, and a plural are not a console.
    expect(matchTitle('Mortal Kombat', 'Mortal Kombat X')).toBeNull()
    expect(matchTitle('Mega Man', 'Mega Man X')).toBeNull()
    expect(matchTitle('Battlefield', 'Battlefield One')).toBeNull()
    expect(matchTitle('Persona 5', 'Persona 5 S')).toBeNull()
    expect(matchTitle('Mortal Kombat', 'Mortal Kombat X|S')).toBeNull()
    expect(matchTitle('Mortal Kombat', 'Mortal Kombat Xbox X')).toBeNull()
    // The same letters where they are one.
    expect(matchTitle('Mortal Kombat', 'Mortal Kombat Xbox One')).toBe('edition')
    expect(matchTitle('Mortal Kombat', 'Mortal Kombat Xbox Series X')).toBe('edition')
    expect(matchTitle('Mortal Kombat', 'Mortal Kombat (Series X|S)')).toBe('edition')
  })

  it('needs the name whole, at the front, and ended where a word ends', () => {
    expect(matchTitle('DOOM', 'DOOMBRINGER Gold Edition')).toBeNull()
    expect(matchTitle('Tony Hawk', "Tony Hawk's Gold Edition")).toBeNull()
    expect(matchTitle('N', 'N++ Ultimate Edition')).toBeNull()
    expect(
      matchTitle('Rainbow Six Siege', "Tom Clancy's Rainbow Six Siege Gold Edition"),
    ).toBeNull()
    expect(matchTitle('Prey Gold Edition', 'Prey')).toBeNull()
  })

  it('needs a word that names an edition: joiners and punctuation alone name none', () => {
    expect(matchTitle('Prey', 'Prey: The')).toBeNull()
    expect(matchTitle('Prey', 'Prey and the')).toBeNull()
    expect(matchTitle('Prey', 'Prey!')).toBeNull()
    expect(matchTitle('Prey', 'Prey (&)')).toBeNull()
    expect(matchTitle('Prey', 'Prey +')).toBeNull()
    expect(matchTitle('Prey', 'Prey + Gold Edition')).toBeNull()
  })

  it('judges two folded strings as it judges two titles', () => {
    expect(matchComparableTitle('prey', 'prey')).toBe('name')
    expect(matchComparableTitle('prey', 'prey - gold edition')).toBe('edition')
    expect(matchComparableTitle('prey', 'prey: mooncrash')).toBeNull()
    expect(matchComparableTitle('', '')).toBeNull()
  })

  it('is held to the list as the owner ruled it', () => {
    expect(EDITION_WORDS).toEqual({
      edition: [
        'standard',
        'edition',
        'enhanced',
        'remastered',
        'definitive',
        'complete',
        'game of the year',
        'goty',
        'gold',
        'ultimate',
        'anniversary',
        "director's cut",
      ],
      platform: ['pc', 'windows', 'windows 10', 'xbox', 'one', 'series', 'x', 's', 'x|s'],
      joiner: ['for', 'the', 'and', '&'],
    })
    const listed: string[] = Object.values(EDITION_WORDS).flat()
    for (const word of ['deluxe', 'premium', 'bundle', 'pack', 'season pass', 'upgrade']) {
      expect(listed).not.toContain(word)
    }
  })
})

describe('isReleasedInTime', () => {
  const at = (day: string) => Date.parse(`${day}T00:00:00.000Z`)

  it('is a year, and "no more than"', () => {
    expect(RELEASE_TOLERANCE_MS).toBe(365 * 86_400_000)
    // Prey, 2017-05-05: a product dated a year before it to the day, and one a day older.
    expect(isReleasedInTime('2017-05-05', at('2016-05-05'))).toBe(true)
    expect(isReleasedInTime('2017-05-05', at('2016-05-04'))).toBe(false)
  })

  it('refuses a product older than the game: another game of the same name', () => {
    expect(isReleasedInTime('2017-05-05', at('2006-07-11'))).toBe(false)
  })

  it('asks nothing of a later date: a store re-lists a game', () => {
    // The Resident Evil Village the Microsoft Store sells is dated 2026; the game is of 2021.
    expect(isReleasedInTime('2021-05-07', at('2026-01-20'))).toBe(true)
    // What the catalog writes when it has no date at all.
    expect(isReleasedInTime('2021-05-07', at('9998-12-30'))).toBe(true)
  })

  it('finds nothing for a game the index has no release date for', () => {
    expect(isReleasedInTime(null, at('2026-01-20'))).toBe(false)
    expect(isReleasedInTime(undefined, at('2026-01-20'))).toBe(false)
    expect(isReleasedInTime('next year', at('2026-01-20'))).toBe(false)
    expect(isReleasedInTime('2021-13-45', at('2026-01-20'))).toBe(false)
  })

  it('reads a document’s date as the day it names, in UTC', () => {
    expect(gameReleasedAt('2021-05-07')).toBe(Date.UTC(2021, 4, 7))
    expect(gameReleasedAt('2021-05-07T12:00:00Z')).toBeNull()
    expect(gameReleasedAt(null)).toBeNull()
  })
})
