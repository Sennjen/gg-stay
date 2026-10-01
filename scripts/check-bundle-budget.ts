import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

/**
 * Fails when the JavaScript a cold visit to `/games` downloads grows past its budget.
 *
 * Run against a production build that is being served: it asks the running server for the
 * `/games` HTML, takes exactly the modules that page loads on first visit — the entry
 * `<script type="module">` plus every `<link rel="modulepreload">` — and compresses each file from
 * the build's public directory at gzip level 9. That is the method behind the table in
 * `docs/perf/README.md` ("JavaScript budget for /games, measured"). Client assets are the same
 * between the node-server and the Vercel preset apart from the build-time site URL baked into the
 * entry chunk (a few bytes, and a different file hash), so a node build measures the deployed
 * bundle.
 *
 *   QUALITY_BASE_URL=http://localhost:3000 pnpm check:bundle-budget
 */

/**
 * `/games` first-load JavaScript, gzip level 9, measured on 2026-10-01 (eight modules, 137 745
 * bytes — 134.5 KiB) plus 5 % headroom. The 120 KB target in ADR-002 stays recorded there as
 * missed; this number is a ratchet against growth, not a new target. Raise it only together with
 * a measurement in `docs/perf/README.md` and a line in ADR-002.
 */
export const MEASURED_BYTES = 137_745
export const BUNDLE_BUDGET_BYTES = Math.ceil(MEASURED_BYTES * 1.05)

export interface ChunkSize {
  path: string
  raw: number
  gzip: number
}

export interface FirstLoadJs {
  chunks: ChunkSize[]
  totalRaw: number
  totalGzip: number
}

const TAG = /<(script|link)\b([^>]*)>/gi
const ATTRIBUTE = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

function attributesOf(source: string): Map<string, string> {
  const attributes = new Map<string, string>()
  for (const [, name, double, single, bare] of source.matchAll(ATTRIBUTE)) {
    if (name) attributes.set(name.toLowerCase(), double ?? single ?? bare ?? '')
  }
  return attributes
}

/** Same-origin paths only, without query or fragment; anything with a scheme or `//` is skipped. */
function sameOriginPath(url: string): string | null {
  if (!url.startsWith('/') || url.startsWith('//')) return null
  return url.replace(/[?#].*$/, '')
}

/**
 * The modules a browser fetches for this HTML before the page is interactive, in page order and
 * each once. Prefetches are left out on purpose: they are idle-time downloads for later routes.
 */
export function firstLoadScripts(html: string): string[] {
  const paths: string[] = []
  for (const [, tag, rawAttributes] of html.matchAll(TAG)) {
    const attributes = attributesOf(rawAttributes ?? '')
    let url: string | undefined
    if (tag!.toLowerCase() === 'script' && attributes.get('type') === 'module') {
      url = attributes.get('src')
    } else if (tag!.toLowerCase() === 'link') {
      const rel = (attributes.get('rel') ?? '').toLowerCase().split(/\s+/)
      if (rel.includes('modulepreload')) url = attributes.get('href')
    }
    const path = url ? sameOriginPath(url) : null
    if (path && !paths.includes(path)) paths.push(path)
  }
  return paths
}

/** Reads every first-load module from `publicDir` and sizes it raw and at gzip level 9. */
export async function measureFirstLoadJs(html: string, publicDir: string): Promise<FirstLoadJs> {
  const paths = firstLoadScripts(html)
  if (paths.length === 0) {
    throw new Error('the page has no module scripts or modulepreloads — is this the right page?')
  }
  const root = resolve(publicDir)
  const chunks: ChunkSize[] = []
  for (const path of paths) {
    const file = resolve(root, `.${decodeURIComponent(path)}`)
    if (!file.startsWith(root + sep)) throw new Error(`${path} resolves outside ${root}`)
    let content: Buffer
    try {
      content = await readFile(file)
    } catch {
      throw new Error(`${path} is loaded by the page but is not in ${root}`)
    }
    chunks.push({ path, raw: content.length, gzip: gzipSync(content, { level: 9 }).length })
  }
  return {
    chunks,
    totalRaw: chunks.reduce((sum, chunk) => sum + chunk.raw, 0),
    totalGzip: chunks.reduce((sum, chunk) => sum + chunk.gzip, 0),
  }
}

const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`

/** Pass or fail against `budget`, with the line the CLI prints; over by one byte is a failure. */
export function budgetVerdict(
  result: FirstLoadJs,
  budget: number,
): { ok: boolean; message: string } {
  const sizes = `${result.totalGzip} bytes (${kib(result.totalGzip)}) against a budget of ${budget} bytes (${kib(budget)})`
  if (result.totalGzip <= budget) return { ok: true, message: `✔ ${sizes}` }
  return {
    ok: false,
    message:
      `✖ over budget: ${sizes}.\n` +
      '  Find what grew in the list above. If the growth is wanted, measure it, record it in ' +
      'docs/perf/README.md and ADR-002, and raise MEASURED_BYTES in this script in the same change.',
  }
}

async function main(): Promise<number> {
  const base = process.env.QUALITY_BASE_URL ?? 'http://localhost:3000'
  const publicDir = process.env.BUNDLE_PUBLIC_DIR ?? '.output/public'
  const pageUrl = new URL('/games', base)

  const response = await fetch(pageUrl)
  if (!response.ok) {
    console.error(`✖ ${pageUrl} answered ${response.status}; start the production build first`)
    return 1
  }
  const result = await measureFirstLoadJs(await response.text(), publicDir)

  console.log(`First-load JavaScript of ${pageUrl.pathname} (gzip -9):`)
  for (const chunk of result.chunks) {
    console.log(
      `  ${chunk.path.padEnd(28)} ${String(chunk.raw).padStart(8)} raw ${String(chunk.gzip).padStart(8)} gz`,
    )
  }
  const verdict = budgetVerdict(result, BUNDLE_BUDGET_BYTES)
  if (verdict.ok) console.log(verdict.message)
  else console.error(verdict.message)
  return verdict.ok ? 0 : 1
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main()
}
