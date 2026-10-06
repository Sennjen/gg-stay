import type { Ref } from 'vue'

/**
 * How long the page waits before it asks again for an answer that came back partial: three
 * seconds after the answer it has, and six seconds after the next one if that is partial too.
 * Two attempts, and then none.
 *
 * The server answers a slow game page from what it has and leaves the requests it stopped waiting
 * for running, so that their answers reach its cache (`server/graphql/resolvers/game.ts`). Three
 * seconds is about when a slow RAWG answer has landed there; the second attempt comes after the
 * transport's own timeout and its one retry have both run out, when whatever RAWG was going to
 * say, it has said.
 *
 * Each wait is counted from the arrival of the answer it follows, never from when that answer was
 * asked for, so the page is never asking twice at once however slow an answer is.
 */
export const PARTIAL_RETRY_DELAYS_MS: readonly number[] = [3_000, 6_000]

/** What `useGql` hands a page about one operation, as far as asking it again goes. */
interface RetriedQuery<TData> {
  /** The answer the page is showing. Written to here, a complete one replaces it in place. */
  data: Ref<TData | null | undefined>
  /** What the operation is being asked for; when it changes, the page is about something else. */
  key: Readonly<Ref<string>>
  /** Asks once more without the page's own state moving, and fails by rejecting. */
  request: () => Promise<TData | null>
}

/**
 * Asks an operation again, by itself and quietly, for as long as its answer is partial — and puts
 * the complete answer on the page when one comes.
 *
 * `partial(answer)` says how an answer stands: `true` when it left something out, `false` when it
 * is whole, and `undefined` when it holds nothing to judge (no answer, or an answer without the
 * thing asked for). Only `true` on the page starts the asking, and only `false` from the server
 * ends it with a new page.
 *
 * Quietly means the page a visitor is reading is never made worse by the asking:
 *
 * - **Only a complete answer is put on the page.** A second partial answer is not: it can be
 *   built from other parts than the first — the index instead of RAWG, on another server
 *   instance — and swapping one incomplete page for another could take away something the visitor
 *   is looking at. The page changes once, when everything is there.
 * - **A failed attempt is an attempt, and nothing else.** It goes through `request`, not through
 *   the page's own `refresh`, which would replace the page with an error for a request the
 *   visitor never made.
 * - **Nothing is scheduled outside a browser.** All of it starts when the component is mounted —
 *   for a server-rendered page, when it has hydrated — so a server render never sets a timer, and
 *   the three seconds are counted where the visitor is.
 * - **Nothing outlives the page it was for.** Leaving the page, the page turning to another game,
 *   and a new answer arriving by any other way each clear the wait and disown the request that is
 *   still out: its answer, when it comes, is dropped.
 *
 * A new answer starts the count again: the two attempts belong to the answer on the page, not to
 * the visit.
 */
export function useRetryWhilePartial<TData>(
  query: RetriedQuery<TData>,
  partial: (answer: TData | null | undefined) => boolean | undefined,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  /** Attempts made for the answer on the page. */
  let attempts = 0
  /** Goes up whenever what is on the page stops being what an attempt was made for. */
  let generation = 0

  /** Clears the wait and disowns the attempt that is out, if there is one. */
  function stop(): void {
    clearTimeout(timer)
    timer = undefined
    generation += 1
  }

  function schedule(): void {
    const delay = PARTIAL_RETRY_DELAYS_MS[attempts]
    if (delay !== undefined) timer = setTimeout(askAgain, delay)
  }

  async function askAgain(): Promise<void> {
    timer = undefined
    attempts += 1
    const asked = generation
    let answer: TData | null | undefined
    try {
      answer = await query.request()
    } catch {
      // Nothing to show for it; the page stays as it is, and the next attempt may do better.
    }
    if (asked !== generation) return
    // Writing the answer is itself "a new answer arrived", which ends this round below.
    if (partial(answer) === false) query.data.value = answer
    else schedule()
  }

  /** The answer on the page is a new one: whatever was pending was for the last. */
  function restart(): void {
    stop()
    attempts = 0
    if (partial(query.data.value) === true) schedule()
  }

  onMounted(() => {
    // The old answer stays on the page until the new one arrives, so the key is what says first
    // that the page has moved on.
    watch(query.key, stop)
    watch(query.data, restart)
    restart()
  })
  onBeforeUnmount(stop)
}
