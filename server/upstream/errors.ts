export type UpstreamKind = 'RATE_LIMITED' | 'TIMEOUT' | 'ERROR' | 'NOT_FOUND'
/**
 * Which third-party API failed. Part of the error so a Steam failure never reads as a RAWG one.
 *
 * The site talks to the first two. GOG, the Microsoft Store and the National Bank of Ukraine are
 * the refresh job's alone (`scripts/index/storeUpstream.ts`): their transports are built from the
 * same factory, and no resolver has one. The PlayStation Store is the job's alone too, through a
 * transport of its own that is far slower than the factory's (`scripts/index/playstation.ts`).
 */
export type UpstreamSource = 'RAWG' | 'STEAM' | 'GOG' | 'MICROSOFT' | 'NBU' | 'PLAYSTATION'

export class UpstreamError extends Error {
  constructor(
    public readonly source: UpstreamSource,
    public readonly kind: UpstreamKind,
    public readonly status?: number,
  ) {
    super(`${source} upstream failure: ${kind}${status ? ` (${status})` : ''}`)
    this.name = 'UpstreamError'
  }
}
