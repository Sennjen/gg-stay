import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BUNDLE_BUDGET_BYTES,
  budgetVerdict,
  firstLoadScripts,
  MEASURED_BYTES,
  measureFirstLoadJs,
} from '../../scripts/check-bundle-budget'

/** Three made-up chunks of different sizes and compressibility, written into a fake build. */
const ENTRY = 'export const entry = 1;\n'.repeat(400)
const VENDOR = Array.from({ length: 300 }, (_, i) => `export const v${i} = ${i * 7919};`).join('\n')
const PAGE = 'console.log("page")\n'
const LAZY = 'console.log("only on click")\n'.repeat(50)

const gz = (text: string) => gzipSync(Buffer.from(text), { level: 9 }).length

/** What a Nuxt production build serves for a page: an entry module and its modulepreloads. */
const HTML = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="/_nuxt/entry.css" crossorigin>
<link rel="modulepreload" as="script" crossorigin href="/_nuxt/entry.js">
<link rel="modulepreload" as="script" crossorigin href="/_nuxt/vendor.js">
<link crossorigin href="/_nuxt/page.js?v=1" as="script" rel="modulepreload">
<link rel="prefetch" as="script" crossorigin href="/_nuxt/lazy.js">
<link rel="preload" as="font" crossorigin href="/_fonts/inter.woff2">
<script type="module" src="/_nuxt/entry.js" crossorigin></script>
<script type="importmap">{"imports":{"#entry":"/_nuxt/entry.js"}}</script>
<script src="https://example.com/third-party.js"></script>
</head><body><div id="__nuxt"></div></body></html>`

describe('firstLoadScripts', () => {
  it('lists the entry module and every modulepreload once, in page order, without query strings', () => {
    expect(firstLoadScripts(HTML)).toEqual([
      '/_nuxt/entry.js',
      '/_nuxt/vendor.js',
      '/_nuxt/page.js',
    ])
  })

  it('ignores prefetches, stylesheets, fonts, inline scripts and other origins', () => {
    const scripts = firstLoadScripts(HTML)
    expect(scripts).not.toContain('/_nuxt/lazy.js')
    expect(scripts.some((path) => path.includes('example.com'))).toBe(false)
  })

  it('reads an entry module that is only a script tag, with attributes in any order', () => {
    const html = `<script crossorigin src="/_nuxt/only.js" type="module"></script>`
    expect(firstLoadScripts(html)).toEqual(['/_nuxt/only.js'])
  })
})

describe('measureFirstLoadJs', () => {
  let publicDir: string

  beforeAll(async () => {
    publicDir = await mkdtemp(join(tmpdir(), 'bundle-budget-'))
    await mkdir(join(publicDir, '_nuxt'))
    await writeFile(join(publicDir, '_nuxt/entry.js'), ENTRY)
    await writeFile(join(publicDir, '_nuxt/vendor.js'), VENDOR)
    await writeFile(join(publicDir, '_nuxt/page.js'), PAGE)
    await writeFile(join(publicDir, '_nuxt/lazy.js'), LAZY)
  })

  afterAll(async () => {
    await rm(publicDir, { recursive: true, force: true })
  })

  it('sums the gzip size of exactly the first-load modules, each counted once', async () => {
    const result = await measureFirstLoadJs(HTML, publicDir)
    expect(result.chunks).toEqual([
      { path: '/_nuxt/entry.js', raw: ENTRY.length, gzip: gz(ENTRY) },
      { path: '/_nuxt/vendor.js', raw: VENDOR.length, gzip: gz(VENDOR) },
      { path: '/_nuxt/page.js', raw: PAGE.length, gzip: gz(PAGE) },
    ])
    expect(result.totalGzip).toBe(gz(ENTRY) + gz(VENDOR) + gz(PAGE))
    expect(result.totalRaw).toBe(ENTRY.length + VENDOR.length + PAGE.length)
  })

  it('fails loudly when the page asks for a module the build does not contain', async () => {
    const html = `<script type="module" src="/_nuxt/missing.js"></script>`
    await expect(measureFirstLoadJs(html, publicDir)).rejects.toThrow(/missing\.js/)
  })

  it('refuses a path that would read outside the build', async () => {
    const html = `<script type="module" src="/_nuxt/../../etc/passwd"></script>`
    await expect(measureFirstLoadJs(html, publicDir)).rejects.toThrow(/outside/)
  })

  it('fails when the page has no first-load modules at all, rather than passing on zero', async () => {
    await expect(measureFirstLoadJs('<html></html>', publicDir)).rejects.toThrow(/no module/)
  })
})

describe('BUNDLE_BUDGET_BYTES', () => {
  it('is the recorded measurement plus 5 %, rounded up to a whole byte', () => {
    expect(BUNDLE_BUDGET_BYTES).toBe(Math.ceil(MEASURED_BYTES * 1.05))
  })
})

describe('budgetVerdict', () => {
  const result = { chunks: [], totalRaw: 0, totalGzip: 1000 }

  it('passes at or under the budget and says so', () => {
    expect(budgetVerdict({ ...result, totalGzip: 1000 }, 1000)).toEqual({
      ok: true,
      message: expect.stringMatching(/^✔ 1000 bytes .* budget of 1000 bytes/),
    })
  })

  it('fails one byte over and tells the reader what to do', () => {
    const verdict = budgetVerdict({ ...result, totalGzip: 1001 }, 1000)
    expect(verdict.ok).toBe(false)
    expect(verdict.message).toMatch(/^✖ over budget: 1001 bytes/)
    expect(verdict.message).toContain('MEASURED_BYTES')
  })
})
