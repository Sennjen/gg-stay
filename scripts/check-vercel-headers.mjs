#!/usr/bin/env node
/**
 * Fails when the compiled Vercel route table injects a Content-Security-Policy.
 *
 * Run straight after `NITRO_PRESET=vercel nuxt build`, against `.vercel/output/config.json`.
 *
 * Why this exists: a `routeRules` header is compiled into a proxy-level route entry, which Vercel
 * applies to the outgoing response — either replacing the function's own header or making the
 * browser enforce the intersection of the two. The app's policy carries per-response sha256 hashes
 * of the scripts Nuxt inlines; a hash-free policy from the CDN blocks them, and every page renders
 * from the server and then fails to hydrate. It only happens under this preset, and only in
 * production, so nothing in a dev run or a node-preset test can see it. The CSP is sent from
 * `server/plugins/csp.ts` alone; this is the check that the build agrees.
 *
 * `tests/server/securityHeaders.test.ts` asserts the same thing against the source config, which is
 * what catches the mistake at the moment it is made. This catches it in the built artifact, which
 * is what catches a preset or framework change nobody wrote.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const CSP_HEADER = 'content-security-policy'
const CONFIG = resolve(process.cwd(), '.vercel/output/config.json')

function fail(message) {
  console.error(`✖ ${message}`)
  process.exit(1)
}

let raw
try {
  raw = await readFile(CONFIG, 'utf-8')
} catch {
  fail(
    `no ${CONFIG}. Run \`NITRO_PRESET=vercel pnpm build\` before this check, and before deleting ` +
      `the output.`,
  )
}

let routes
try {
  routes = JSON.parse(raw).routes ?? []
} catch (error) {
  fail(`${CONFIG} is not valid JSON: ${error.message}`)
}

const offenders = routes.filter((route) =>
  Object.keys(route?.headers ?? {}).some((name) => name.toLowerCase() === CSP_HEADER),
)

if (offenders.length > 0) {
  console.error('Routes in the Vercel output that inject a Content-Security-Policy:')
  for (const route of offenders) console.error(`  ${route.src ?? '(no src)'}`)
  fail(
    'the CSP must come only from server/plugins/csp.ts, which adds the per-response script ' +
      'hashes. A policy set here has none of them and stops every page hydrating.',
  )
}

console.log(`✔ no Content-Security-Policy in the Vercel route table (${routes.length} routes)`)
