/**
 * Which of RAWG's two API keys a request goes with: the main one (`RAWG_API_KEY`), until RAWG
 * refuses it, and the spare one (`RAWG_API_KEY_SPARE`) from then on.
 *
 * RAWG answers a key whose free quota is spent with a 401, and a key it will not take for another
 * reason with a 401 or a 403. Either, to a request that went with the main key, switches the
 * process to the spare key for good: the refused request is sent once more with it, and so is
 * every request after it. There is no switching back — a quota does not come back within a
 * function instance's life or a job's run — and a refusal of the spare key, or of the main one
 * where no spare is configured, is the error it always was.
 *
 * One of these a process: the site builds one with its RAWG transport (`server/utils/rawg.ts`),
 * which is one an instance, and the job one with its own (`scripts/index/upstreams.ts`), which is
 * one a run.
 *
 * The keys are never in what this says: the line about the switch names the status alone.
 */
export interface RawgKeys {
  /** The key the next request goes with. */
  current: () => string
  /**
   * What to send a request with once more, now that RAWG answered it with `status`: the spare key,
   * when the request went with the main key, the status is a 401 or a 403 and there is a spare to
   * go to — or nothing, and the refusal is the request's answer. The first refusal switches the
   * process to the spare key, and is told to `onSwitch`; a request sent with the main key
   * before that and refused after it is sent again with the spare key too, and writes nothing.
   */
  afterRefusal: (used: string, status: number) => string | undefined
  /** The status that switched the process to the spare key, or `null` while it is on the main one. */
  switchedAfter: () => number | null
}

export interface RawgKeysOptions {
  main: string
  /** The spare key; none when it is empty or omitted, and a refusal is then the request's answer. */
  spare?: string
  /**
   * Called once, with RAWG's status, when the process leaves the main key: the place for the one
   * line about it (`keySwitchLine`).
   */
  onSwitch: (status: number) => void
}

/** The statuses that mean RAWG refused the key, rather than the request. */
export function isKeyRefusal(status: number | undefined): boolean {
  return status === 401 || status === 403
}

/** The line written once a process, when it leaves the main key for the spare one. */
export function keySwitchLine(status: number): string {
  return `[upstream] RAWG main key refused (${status}), switched to the spare key`
}

export function createRawgKeys(options: RawgKeysOptions): RawgKeys {
  const { main, onSwitch } = options
  const spare = options.spare ?? ''
  let switchedAfter: number | null = null

  return {
    current: () => (switchedAfter === null ? main : spare),
    afterRefusal(used, status) {
      if (!isKeyRefusal(status) || !spare || used !== main || main === spare) return undefined
      if (switchedAfter === null) {
        switchedAfter = status
        onSwitch(status)
      }
      return spare
    },
    switchedAfter: () => switchedAfter,
  }
}
