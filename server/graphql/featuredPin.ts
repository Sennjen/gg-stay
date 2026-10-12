/**
 * A game put on the landing's screen by hand, for a while. The landing otherwise picks its own
 * (`pickFeatured`, `server/rawg/landing.ts`) and finds a trailer for it at RAWG or Steam; a pin
 * is for the game neither of those can serve — one that is not out yet, or is not on Steam — and
 * brings the trailer with it.
 */
export interface FeaturedPin {
  /** RAWG's id for the game. Not its slug: RAWG renames those, and an id is what stays. */
  rawgId: number
  /** The last day the pin holds, inclusive, as a UTC `YYYY-MM-DD` — the shape of `context.today`. */
  until: string
  /**
   * The trailer, already cut for the screen: muted, no taller than 720p, without the rating card
   * and the logos a trailer opens and closes on. Its origin has to be named in `media-src`
   * (`server/security/headers.ts`), or the browser silently refuses to play it.
   */
  clipUrl: string
  /** Whose trailer it is, for the line under "now on screen". */
  clipCredit: string
}

/**
 * What is pinned, first match wins. An entry past its `until` does nothing and can be deleted at
 * leisure: the landing goes back to its own pick by itself, on the first render of the next day.
 */
export const FEATURED_PINS: readonly FeaturedPin[] = [
  // Grand Theft Auto VI, out on 2026-11-19 on consoles only: there is no Steam page to take a
  // trailer from and RAWG has no clip. Rockstar's second trailer, through the release month.
  {
    rawgId: 972995,
    until: '2026-11-30',
    clipUrl: 'https://ilvgxc1q6vjaiqyd.public.blob.vercel-storage.com/gta-vi-trailer-2-hero.mp4',
    clipCredit: 'Rockstar Games',
  },
]

/** The pin in force on `today`, or null when the landing should pick for itself. */
export function activePin(today: string, pins: readonly FeaturedPin[]): FeaturedPin | null {
  return pins.find((pin) => today <= pin.until) ?? null
}
