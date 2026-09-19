import { describe, expect, it } from 'vitest'
import { pickTrailer, steamAppIdFromUrl } from '../../server/steam/steam'

describe('steamAppIdFromUrl', () => {
  it.each([
    [
      'https://store.steampowered.com/app/3764200/Resident_Evil_Requiem/',
      '3764200',
      'with a trailing slug',
    ],
    ['https://store.steampowered.com/app/292030/', '292030', 'with a trailing slash, no slug'],
    ['https://store.steampowered.com/app/292030', '292030', 'without a trailing slash'],
    ['http://store.steampowered.com/app/292030/', '292030', 'plain http'],
    ['https://store.steampowered.com/app/292030?snr=1_5_9__205', '292030', 'with a query string'],
  ])('extracts %s -> %s (%s)', (url, expected) => {
    expect(steamAppIdFromUrl(url)).toBe(expected)
  })

  it.each([
    ['https://www.gog.com/game/the_witcher_3_wild_hunt', 'a non-Steam url'],
    ['not a url', 'garbage input'],
    [null, 'null'],
    [undefined, 'undefined'],
  ])('returns null for %s (%s)', (url) => {
    expect(steamAppIdFromUrl(url)).toBeNull()
  })
})

describe('pickTrailer', () => {
  it('picks the first highlight movie', () => {
    const movies = [
      { id: 1, hls_h264: 'https://cdn.test/1/hls_264_master.m3u8', highlight: false },
      { id: 2, hls_h264: 'https://cdn.test/2/hls_264_master.m3u8', highlight: true },
    ]
    expect(pickTrailer(movies)).toBe('https://cdn.test/2/hls_264_master.m3u8')
  })

  it('falls back to the first movie when none are highlighted', () => {
    const movies = [
      { id: 1, hls_h264: 'https://cdn.test/1/hls_264_master.m3u8' },
      { id: 2, hls_h264: 'https://cdn.test/2/hls_264_master.m3u8' },
    ]
    expect(pickTrailer(movies)).toBe('https://cdn.test/1/hls_264_master.m3u8')
  })

  it('returns null for an empty or missing list', () => {
    expect(pickTrailer([])).toBeNull()
    expect(pickTrailer(null)).toBeNull()
    expect(pickTrailer(undefined)).toBeNull()
  })
})
