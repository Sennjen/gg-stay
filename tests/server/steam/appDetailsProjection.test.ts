import { describe, expect, it } from 'vitest'
import { projectAppDetails } from '../../../server/steam/appDetailsProjection'

describe('projectAppDetails', () => {
  it('reduces a large fixture-like payload to only the fields this app reads', () => {
    const raw = {
      '292030': {
        success: true,
        // Fields nothing in this app reads — must be dropped.
        unknown_top_level: 'drop me',
        data: {
          type: 'game',
          name: 'The Witcher 3: Wild Hunt',
          steam_appid: 292030,
          required_age: 18,
          is_free: false,
          detailed_description: '<p>A very long HTML block…</p>'.repeat(200),
          about_the_game: '<p>Про гру</p>',
          short_description: 'Короткий опис.',
          supported_languages: 'Ukrainian, English, Polish',
          header_image: 'https://example.com/header.jpg',
          capsule_image: 'https://example.com/capsule.jpg',
          website: 'https://thewitcher.com',
          pc_requirements: { minimum: '<p>...</p>', recommended: '<p>...</p>' },
          mac_requirements: [],
          linux_requirements: [],
          developers: ['CD PROJEKT RED'],
          publishers: ['CD PROJEKT RED'],
          price_overview: {
            currency: 'UAH',
            initial: 100000,
            final: 50000,
            discount_percent: 50,
            initial_formatted: '1000 грн',
            final_formatted: '500 грн',
            // Unknown sub-field — must be dropped.
            recurring_sub: 0,
          },
          packages: [12345],
          package_groups: [{ huge: 'nested payload' }],
          platforms: { windows: true, mac: false, linux: false },
          categories: [{ id: 2, description: 'Single-player' }],
          genres: [{ id: '3', description: 'RPG' }],
          screenshots: Array.from({ length: 50 }, (_, i) => ({
            id: i,
            path_thumbnail: `https://example.com/${i}_thumb.jpg`,
            path_full: `https://example.com/${i}_full.jpg`,
          })),
          movies: [
            {
              id: 256813022,
              name: 'Launch Trailer',
              thumbnail: 'https://example.com/thumb.jpg',
              highlight: false,
              hls_h264: 'https://example.com/1/hls_264_master.m3u8',
              // Unknown sub-field — must be dropped.
              webm: { '480': 'https://example.com/1/movie480.webm' },
            },
            {
              id: 256813023,
              name: 'Cinematic Trailer',
              thumbnail: 'https://example.com/thumb2.jpg',
              highlight: true,
              hls_h264: 'https://example.com/2/hls_264_master.m3u8',
            },
          ],
          recommendations: { total: 500000 },
          achievements: { total: 78, highlighted: [] },
          release_date: { coming_soon: false, date: '18 May, 2015' },
          support_info: { url: '', email: '' },
          background: 'https://example.com/background.jpg',
          background_raw: 'https://example.com/background_raw.jpg',
          content_descriptors: { ids: [], notes: null },
        },
      },
    }

    expect(projectAppDetails(raw)).toEqual({
      '292030': {
        success: true,
        data: {
          movies: [
            { highlight: false, hls_h264: 'https://example.com/1/hls_264_master.m3u8' },
            { highlight: true, hls_h264: 'https://example.com/2/hls_264_master.m3u8' },
          ],
          about_the_game: '<p>Про гру</p>',
          short_description: 'Короткий опис.',
          supported_languages: 'Ukrainian, English, Polish',
          price_overview: {
            currency: 'UAH',
            initial: 100000,
            final: 50000,
            discount_percent: 50,
            initial_formatted: '1000 грн',
            final_formatted: '500 грн',
          },
          is_free: false,
        },
      },
    })
  })

  it('drops unknown top-level and nested fields', () => {
    expect(
      projectAppDetails({
        '1': { success: true, unknown: 1, data: { unknown_nested: 'x', movies: [] } },
      }),
    ).toEqual({ '1': { success: true, data: { movies: [] } } })
  })

  it('leaves missing fields absent rather than filling in defaults', () => {
    expect(projectAppDetails({ '1': { success: false } })).toEqual({ '1': { success: false } })
    expect(projectAppDetails({ '1': {} })).toEqual({ '1': {} })
  })

  it('does not throw on malformed data and produces an empty projection', () => {
    expect(projectAppDetails(null)).toEqual({})
    expect(projectAppDetails(undefined)).toEqual({})
    expect(projectAppDetails('a string')).toEqual({})
    expect(projectAppDetails(42)).toEqual({})
    expect(projectAppDetails([1, 2, 3])).toEqual({})
    expect(projectAppDetails({ '1': null })).toEqual({ '1': {} })
    expect(projectAppDetails({ '1': 'not an object' })).toEqual({ '1': {} })
    expect(projectAppDetails({ '1': { success: true, data: 'not an object' } })).toEqual({
      '1': { success: true },
    })
    // `data` itself is a valid object, so it's kept — just empty, since its one field is
    // malformed. This differs from the field being absent entirely (see the next test).
    expect(projectAppDetails({ '1': { success: true, data: { movies: 'not an array' } } })).toEqual(
      { '1': { success: true, data: {} } },
    )
    expect(
      projectAppDetails({ '1': { success: true, data: { movies: [null, 'nope', 42, {}] } } }),
    ).toEqual({ '1': { success: true, data: { movies: [{}] } } })
  })

  it('keeps a null hls_h264 (a movie Steam has no HLS stream for) distinct from a missing one', () => {
    expect(
      projectAppDetails({ '1': { data: { movies: [{ highlight: true, hls_h264: null }] } } }),
    ).toEqual({ '1': { data: { movies: [{ highlight: true, hls_h264: null }] } } })
  })

  it('drops price_overview fields with the wrong type instead of throwing', () => {
    expect(
      projectAppDetails({
        '1': { data: { price_overview: { currency: 'UAH', initial: '100', final: null } } },
      }),
    ).toEqual({ '1': { data: { price_overview: { currency: 'UAH' } } } })
  })
})
