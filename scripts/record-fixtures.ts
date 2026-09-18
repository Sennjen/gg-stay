// Usage: RAWG_API_KEY=... node --experimental-strip-types scripts/record-fixtures.ts
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const key = process.env.RAWG_API_KEY
if (!key) throw new Error('RAWG_API_KEY is required')

const targets: [file: string, path: string, params: Record<string, string>][] = [
  ['games', 'games', { page_size: '20', ordering: '-added' }],
  ['game-the-witcher-3-wild-hunt', 'games/the-witcher-3-wild-hunt', {}],
  ['game-the-witcher-3-wild-hunt-stores', 'games/the-witcher-3-wild-hunt/stores', {}],
  ['genres', 'genres', {}],
  ['platforms', 'platforms', {}],
  ['developers', 'developers', { page_size: '10' }],
]

const dir = fileURLToPath(new URL('../tests/fixtures/rawg/', import.meta.url))

async function main() {
  for (const [file, path, params] of targets) {
    const url = new URL(`https://api.rawg.io/api/${path}`)
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    url.searchParams.set('key', key)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    await writeFile(`${dir}${file}.json`, JSON.stringify(await response.json(), null, 2) + '\n')
    console.log(`recorded ${file}.json`)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

await main()
