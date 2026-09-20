export type UpstreamKind = 'RATE_LIMITED' | 'TIMEOUT' | 'ERROR' | 'NOT_FOUND'
/** Which third-party API failed. Part of the error so a Steam failure never reads as a RAWG one. */
export type UpstreamSource = 'RAWG' | 'STEAM'

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
