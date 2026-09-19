// Every field is optional: hand-written fixtures may differ from live Steam payloads. Also: this
// is the *projected* shape (see `server/steam/appDetailsProjection.ts`) — only the fields this
// app actually reads. `pickTrailer` (server/steam/steam.ts) only reads `highlight`/`hls_h264`.
export interface SteamMovie {
  highlight?: boolean
  hls_h264?: string | null
}

export interface SteamPriceOverview {
  currency?: string
  initial?: number
  final?: number
  discount_percent?: number
  initial_formatted?: string
  final_formatted?: string
}

export interface SteamAppDetails {
  success?: boolean
  data?: {
    movies?: SteamMovie[]
    /** HTML. Localised to `l`/`cc` when the publisher provides a translation, English otherwise
     *  (Steam does not signal the fallback — see `server/steam/description.ts`). */
    about_the_game?: string
    /** HTML, usually shorter than `about_the_game`. May be filled when `about_the_game` is empty. */
    short_description?: string
    /** Unused yet — reserved for the upcoming localisation index. */
    supported_languages?: string
    /** Unused yet — reserved for the upcoming price index. */
    price_overview?: SteamPriceOverview
    /** Unused yet — reserved for the upcoming price index. */
    is_free?: boolean
  }
}

/**
 * `GET /api/appdetails?appids={id}` responds keyed by the requested app id. Both the live
 * transport and fixture mode return this already projected down to `SteamAppDetails` (see
 * `server/steam/appDetailsProjection.ts`) — never the full, tens-of-KB Steam payload.
 */
export type SteamAppDetailsResponse = Record<string, SteamAppDetails | undefined>
