import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OG_IMAGE } from '~/utils/seo'

/**
 * The landing declares its share card's size in `og:image:width`/`height` from `OG_IMAGE`; the
 * file itself is drawn by `scripts/og-image.ts`. Reading the PNG's own header keeps the two from
 * drifting apart when either changes.
 */
describe('the landing share card', () => {
  const png = readFileSync(join(process.cwd(), 'public', OG_IMAGE.path))

  it('is a PNG', () => {
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('has exactly the size the head declares, the 1.91:1 of a large preview card', () => {
    expect(png.readUInt32BE(16)).toBe(OG_IMAGE.width)
    expect(png.readUInt32BE(20)).toBe(OG_IMAGE.height)
    expect(OG_IMAGE.width / OG_IMAGE.height).toBeCloseTo(1.905, 2)
  })

  it('stays small enough for every crawler that fetches it', () => {
    expect(png.length).toBeLessThan(300_000)
  })
})
