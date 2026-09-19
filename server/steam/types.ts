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
  } | null
}

/** `GET /api/appdetails?appids={id}` responds keyed by the requested app id. */
export type SteamAppDetailsResponse = Record<string, SteamAppDetails | undefined>
