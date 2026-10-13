import { beforeEach, inject, vi } from 'vitest'

/**
 * Setup for the mutation run alone (`vitest.mutation.config.ts`); `pnpm test` never loads it.
 *
 * StrykerJS runs the suites against instrumented source, in which every mutant is a branch and,
 * while it measures which test reaches which mutant, a counter per test as well. A hot loop then
 * runs tens of times slower than the code as written.
 */
declare module 'vitest' {
  interface ProvidedContext {
    /** Provided by the StrykerJS runner: the measuring pass, or a run against one mutant. */
    mode?: 'dry-run' | 'mutant'
  }
}

// Both passes need more than the default five seconds. The measuring pass, for the suites that
// rank a real-looking corpus. A run against a mutant, because StrykerJS keeps every core busy and
// the heaviest of those suites then takes seconds: at five, it timed out against thirty mutants
// that changed nothing it asserts, and each was reported as killed.
const mode = inject('mode')
if (mode === 'dry-run') vi.setConfig({ testTimeout: 120_000 })
if (mode === 'mutant') vi.setConfig({ testTimeout: 15_000 })

// A test that asserts wall-clock time cannot pass on instrumented source, and StrykerJS refuses to
// start unless every test does. It says nothing about a mutant either way: skipped by name.
const WALL_CLOCK_BUDGETS = new Set(['ranks 3 500 games in a couple of seconds'])

beforeEach((context) => {
  if (WALL_CLOCK_BUDGETS.has(context.task.name)) context.skip()
})
