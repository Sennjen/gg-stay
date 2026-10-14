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
  gamesWithLaterNamesakes,
  RELEASE_LATER_LIMIT_MS,
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
    expect(comparableTitle('Batman\u2122: Arkham Knight')).toBe('batman: arkham knight')
    expect(comparableTitle('Prey\u00AE: Digital Deluxe Edition')).toBe(
      'prey: digital deluxe edition',
    )
    expect(comparableTitle('\u00A9 LIMBO')).toBe('limbo')
    // NFKC alone would spell the sign out: "batmantm".
    expect('Batman\u2122'.normalize('NFKC')).toBe('BatmanTM')
    expect(comparableTitle('Batman\u2122')).toBe('batman')
  })

  it('folds the forms Unicode calls compatible', () => {
    // A no-break space, a fullwidth letter and digit, a Roman numeral in one character.
    expect(comparableTitle('Halo\u00A0Infinite')).toBe('halo infinite')
    expect(comparableTitle('\uFF24\uFF2F\uFF2F\uFF2D \uFF13')).toBe('doom 3')
    expect(comparableTitle('Final Fantasy \u2166')).toBe('final fantasy vii')
  })

  it('reads every dash as a hyphen', () => {
    for (const dash of ['\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2015', '\u2212']) {
      expect(comparableTitle(`Spider${dash}Man`)).toBe('spider-man')
    }
  })

  it('reads every apostrophe as the plain one', () => {
    for (const mark of [
      '\u2018',
      '\u2019',
      '\u201B',
      '\u02B9',
      '\u02BC',
      '\u2032',
      '`',
      '\u00B4',
    ]) {
      expect(comparableTitle(`Assassin${mark}s Creed`)).toBe("assassin's creed")
    }
    expect(comparableTitle('Assassin\uFF07s Creed')).toBe("assassin's creed")
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
    expect(comparableTitle('Pok\u00E9mon')).not.toBe(comparableTitle('Pokemon'))
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
    ['Batman: Arkham Knight', 'Batman\u2122: Arkham Knight'],
    ['Prey', 'Prey\u00AE'],
    ["Assassin's Creed Odyssey", 'Assassin\u2019s Creed\u00AE Odyssey'],
    ['Spider-Man', 'Spider\u2013Man'],
    ['Halo Infinite', ' Halo\u00A0 Infinite '],
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
    ['Pok\u00E9mon', 'Pokemon'],
    ['Prey', 'Pray'],
  ])('%j is not %j', (name, title) => {
    expect(isSameTitle(name, title)).toBe(false)
    expect(matchTitle(name, title)).not.toBe('name')
  })

  it('finds nothing in a name or a title that is not there', () => {
    expect(matchTitle('', '')).toBeNull()
    expect(matchTitle('\u2122', '\u00AE')).toBeNull()
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
    ['The Witcher 3: Wild Hunt', 'The Witcher 3: Wild Hunt \u2014 Remastered'],
    ['The Witcher 3: Wild Hunt', 'The Witcher 3: Wild Hunt \u2014 Game of the Year Edition'],
    ['Resident Evil Village', 'Resident Evil Village Gold Edition'],
    ["Assassin's Creed Odyssey", "Assassin's Creed Odyssey - Ultimate Edition"],
    ["Assassin's Creed Odyssey", "Assassin's Creed Odyssey - Gold Edition"],
    // One for each word of the list that has none above.
    ['Divinity: Original Sin', 'Divinity: Original Sin - Enhanced Edition'],
    ['Dishonored', 'Dishonored: Definitive Edition'],
    ['Borderlands 2', 'Borderlands 2 GOTY'],
    ['Fable', 'Fable Anniversary'],
    ['Deadly Premonition', 'Deadly Premonition: Director\u2019s Cut'],
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
    ['Prey', 'Prey\u00AE: Digital Deluxe Edition'],
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
    [
      'Grand Theft Auto V',
      'Grand Theft Auto V Enhanced (\u041F\u041A) \u0456 \u043A\u043E\u043C\u043F\u043B\u0435\u043A\u0442',
    ],
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
    // Even when what the name runs into is a word of the list: the name has to end first.
    expect(matchTitle('Hollow Cradle', 'Hollow Cradlegold Edition')).toBeNull()
    expect(matchTitle('Hollow Cradle', 'Hollow Cradle Gold Edition')).toBe('edition')
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

  it('believes a later date up to twelve years: a store re-lists a game', () => {
    expect(RELEASE_LATER_LIMIT_MS).toBe(12 * 365.25 * 86_400_000)
    // The Resident Evil Village the Microsoft Store sells is dated 2026; the game is of 2021.
    expect(isReleasedInTime('2021-05-07', at('2026-01-20'))).toBe(true)
    // Grand Theft Auto V Enhanced (PC), listed eleven and a half years after the game: the
    // longest gap among the finds recorded on 2026-10-13.
    expect(isReleasedInTime('2013-09-17', Date.parse('2025-04-15T15:00:00.000Z'))).toBe(true)
    // Twelve years to the day, and a day past them.
    expect(isReleasedInTime('2013-09-17', at('2025-09-17'))).toBe(true)
    expect(isReleasedInTime('2013-09-17', at('2025-09-18'))).toBe(false)
  })

  it.each([
    ['Dead Space', '2008-10-14', '2023-01-27'],
    ['Resident Evil 4', '2005-01-11', '2023-03-24'],
    ['System Shock', '1994-09-23', '2023-05-30'],
    ['Saints Row', '2006-08-29', '2022-08-23'],
    ['Prey', '2006-07-11', '2023-02-28'],
    ['Tomb Raider (Definitive Edition, for the 1996 game)', '1996-10-25', '2014-01-28'],
    ['Fable', '2004-09-14', '2026-02-01'],
  ])(
    'refuses %s: the remake that took the name came more than twelve years later',
    (_game, game, remake) => {
      expect(isReleasedInTime(game, at(remake))).toBe(false)
    },
  )

  it('refuses the date the catalog writes when it has none', () => {
    expect(isReleasedInTime('2021-05-07', at('9998-12-30'))).toBe(false)
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

describe('gamesWithLaterNamesakes', () => {
  const game = (id: number, name: string, released: string | null) => ({ id, name, released })

  it('names every game a later game of the run shares its name with, typography aside', () => {
    expect(
      gamesWithLaterNamesakes([
        game(1, 'Dead Space', '2008-10-14'),
        game(2, 'DEAD SPACE\u2122', '2023-01-27'),
        game(3, 'Resident Evil 4', '2005-01-11'),
        game(4, 'Resident Evil 4', '2023-03-24'),
        game(5, 'System Shock', '1994-09-23'),
        game(6, 'System Shock', '2023-05-30'),
        game(7, 'Prey', '2017-05-05'),
      ]),
    ).toEqual(new Set([1, 3, 5]))
  })

  it('leaves the latest of the name alone, and a name nobody else has', () => {
    const shadowed = gamesWithLaterNamesakes([
      game(1, 'Saints Row', '2006-08-29'),
      game(2, 'Saints Row', '2022-08-23'),
      game(3, 'Saints Row 2', '2008-10-14'),
    ])
    expect(shadowed).toEqual(new Set([1]))
  })

  it('takes nothing from a game without a date: it is no later one, and is found by no title anyway', () => {
    expect(
      gamesWithLaterNamesakes([game(1, 'Fable', '2004-09-14'), game(2, 'Fable', null)]),
    ).toEqual(new Set())
    expect(
      gamesWithLaterNamesakes([game(1, 'Fable', null), game(2, 'Fable', '2004-09-14')]),
    ).toEqual(new Set())
  })

  it('names neither of two games of one name released the same day', () => {
    expect(
      gamesWithLaterNamesakes([game(1, 'Twin', '2020-01-01'), game(2, 'Twin', '2020-01-01')]),
    ).toEqual(new Set())
  })
})
