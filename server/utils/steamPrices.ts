import { createSteamPriceFetch, type SteamPriceFetch } from '../steam/steamPriceFetch'
import { STEAM_BURST } from './steam'

let instance: SteamPriceFetch | undefined

/**
 * The Steam price transport. The site only ever uses its read of one app's price, to refresh one
 * game's price on its own page; the batched side belongs to the refresh job.
 *
 * That read has a limiter of its own, apart from the one of Steam's page about an app
 * (`useSteam`), with the same pace and the same burst (`STEAM_BURST` says what the two add up
 * to). The per-app transport is handed over for the language read alone, which the site does not
 * make.
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
    burst: STEAM_BURST,
    steamFetch: useSteam(),
  })
  return instance
}
