/**
 * Draws the landing's share card, `public/og.png` (1200×630, the size every large preview card
 * uses), from the design tokens — no stock art, nothing hand-edited.
 *
 *     pnpm build && pnpm exec tsx scripts/og-image.ts
 *
 * The card is the SVG built by `cardSvg` below: the colours are read from the `@theme` block of
 * `app/assets/css/main.css`, the mark is the favicon's, and the type is the site's own Tektur and
 * Inter — taken from the production build (`.output/public`), which is where `@nuxt/fonts` puts
 * the exact files the site serves, so the script needs no network and no fonts of its own. The SVG
 * is rendered to PNG by the Chromium that `playwright-core` drives, and the PNG is committed: it
 * changes only when the design does, and a deployment should not need a browser to build.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WIDTH = 1200
const HEIGHT = 630

const TOKENS = ['ink', 'surface-1', 'line', 'fg', 'fg-2', 'accent'] as const
type Token = (typeof TOKENS)[number]

/** The colour tokens as `main.css` defines them, so the card cannot drift from the site. */
function readTokens(): Record<Token, string> {
  const css = readFileSync(join(ROOT, 'app/assets/css/main.css'), 'utf8')
  const theme = css.slice(css.indexOf('@theme'))
  const entries = TOKENS.map((token) => {
    const value = new RegExp(`--color-${token}:\\s*([^;]+);`).exec(theme)?.[1]?.trim()
    if (!value) throw new Error(`--color-${token} is not defined in app/assets/css/main.css`)
    return [token, value] as const
  })
  return Object.fromEntries(entries) as Record<Token, string>
}

/**
 * The `@font-face` rules the built site uses for one family, with every font file inlined, so the
 * page the card is drawn on loads nothing.
 */
function builtFontFaces(family: string): string {
  const assets = join(ROOT, '.output/public/_nuxt')
  let files: string[]
  try {
    files = readdirSync(assets).filter((file) => file.endsWith('.css'))
  } catch {
    throw new Error('No production build found: run `pnpm build` first.')
  }
  const faces = files.flatMap((file) =>
    [...readFileSync(join(assets, file), 'utf8').matchAll(/@font-face\{[^}]*\}/g)]
      .map(([rule]) => rule)
      .filter(
        (rule) =>
          new RegExp(`font-family:\\s*["']?${family}["']?;`).test(rule) && rule.includes('_fonts/'),
      ),
  )
  if (faces.length === 0) throw new Error(`The build has no @font-face for ${family}.`)
  return faces
    .map((rule) =>
      rule.replace(/url\((?:\.\.)?\/?_fonts\/([^)]+)\)/g, (_match, name: string) => {
        const font = readFileSync(join(ROOT, '.output/public/_fonts', name))
        return `url(data:font/woff2;base64,${font.toString('base64')})`
      }),
    )
    .join('\n')
}

/** The card itself. Everything on it is a token, a word or the favicon's own mark. */
function cardSvg(color: Record<Token, string>): string {
  // The favicon's "G", drawn on its 32-unit grid and scaled up.
  const mark = 'M20.4 11.1a6.1 6.1 0 1 0 1.5 6.4h-5.1'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${color.ink}" />
  <rect x="40.5" y="40.5" width="1119" height="549" rx="12" fill="${color['surface-1']}" stroke="${color.line}" />
  <g transform="translate(104 104) scale(4)">
    <rect width="32" height="32" rx="7" fill="${color.ink}" stroke="${color.line}" stroke-width="0.25" />
    <path d="${mark}" fill="none" stroke="${color.accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
  </g>
  <text x="100" y="392" fill="${color.fg}" font-family="Tektur" font-size="132" letter-spacing="-2.6">GG Stay</text>
  <text x="104" y="480" fill="${color['fg-2']}" font-family="Inter" font-size="44">Каталог відеоігор для українського гравця</text>
  <text x="104" y="542" fill="${color['fg-2']}" font-family="Inter" font-size="30">Ціни в гривнях · українська локалізація</text>
</svg>`
}

async function main(): Promise<void> {
  const svg = cardSvg(readTokens())
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${builtFontFaces('Tektur')}
${builtFontFaces('Inter')}
html, body { margin: 0; background: transparent; }
svg { display: block; }
</style></head><body>${svg}</body></html>`

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
    await page.setContent(html)
    // Text drawn before its face has loaded would be drawn in the fallback.
    // (A string, because this script is typechecked without the DOM library.)
    const loaded = await page.evaluate(
      `Promise.all(['132px Tektur', '44px Inter'].map((font) => document.fonts.load(font, 'GG Stay Каталог')))` +
        `.then(() => document.fonts.ready)` +
        `.then(() => document.fonts.check('132px Tektur', 'GG Stay') && document.fonts.check('44px Inter', 'Каталог'))`,
    )
    // `document.fonts.load` resolves with an empty list when no face matched, so a card drawn in a
    // fallback face would otherwise be written without a word.
    if (loaded !== true) throw new Error('Tektur or Inter did not load; the card was not written.')
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } })
    writeFileSync(join(ROOT, 'public/og.png'), png)
    console.log(`public/og.png written (${WIDTH}×${HEIGHT}, ${png.length} bytes)`)
  } finally {
    await browser.close()
  }
}

await main()
