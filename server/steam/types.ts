// Every field is optional: hand-written fixtures may differ from live Steam payloads.
export interface SteamMovie {
  id?: number
  name?: string
  thumbnail?: string
  highlight?: boolean
  hls_h264?: string | null
}

export interface SteamAppDetails {
  success?: boolean
  data?: {
    movies?: SteamMovie[] | null
    /** HTML. Localised to `l`/`cc` when the publisher provides a translation, English otherwise
     *  (Steam does not signal the fallback — see `server/steam/description.ts`). */
    about_the_game?: string | null
    /** HTML, usually shorter than `about_the_game`. May be filled when `about_the_game` is empty. */
    short_description?: string | null
  } | null
}

/** `GET /api/appdetails?appids={id}` responds keyed by the requested app id. */
export type SteamAppDetailsResponse = Record<string, SteamAppDetails | undefined>
