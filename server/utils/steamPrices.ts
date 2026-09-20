import { createSteamPriceFetch, type SteamPriceFetch } from '../steam/steamPriceFetch'

let instance: SteamPriceFetch | undefined

/**
 * The batched Steam price transport. The site only ever uses its per-app call, to refresh one
 * game's price on its own page; the batched side belongs to the refresh job. It is built on the
 * same cached per-app transport as the rest of the Steam reads (`useSteam`), so fixture mode and
 * the rate limit are shared rather than reimplemented.
 */
export function useSteamPrices(): SteamPriceFetch {
  if (instance) return instance
  const config = useRuntimeConfig()
  const fixtures = useStorage('assets:steam-fixtures')

  instance = createSteamPriceFetch({
    // One switch drives fixture mode for every upstream, as in `useRawg` and `useSteam`.
    // Env overrides are parsed by destr, so "1" may arrive as the number 1.
    fixtures: String(config.rawgFixtures) === '1',
    fetchJson: async (url, signal) => {
      const response = await fetch(url, { signal })
      const body: unknown = await response.json().catch(() => null)
      return { status: response.status, body }
    },
    readFixture: async (name) => (await fixtures.getItem(`${name}.json`)) ?? null,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    steamFetch: useSteam(),
  })
  return instance
}
