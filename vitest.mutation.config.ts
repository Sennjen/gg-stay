import { configDefaults, defineConfig, type Plugin } from 'vitest/config'

/**
 * Makes the test filter StrykerJS sets match the names Vitest 5 gives tests.
 *
 * For each mutant the runner sets `testNamePattern` to the names of the tests that reach it, each
 * a suite chain joined with a space ("planQuery reads the order set"). Vitest 5 matches the
 * pattern against the chain joined with " > " ("planQuery > reads the order set"), so the filter
 * selects nothing, no test meets the mutant and it is reported as survived: a whole run scores as
 * if the suite asserted nothing (stryker-mutator/stryker-js#6210, open at 9.6.1 and at 10.0.0).
 * The runner cannot tell where a suite name ends, so every space is allowed to be either joiner.
 * To be removed with the first StrykerJS release that carries the fix.
 */
function strykerNamesOnVitest5(): Plugin {
  return {
    name: 'stryker-names-on-vitest-5',
    configureVitest({ project }) {
      let pattern = project.config.testNamePattern
      Object.defineProperty(project.config, 'testNamePattern', {
        configurable: true,
        enumerable: true,
        get: () => pattern,
        set(value: RegExp | undefined) {
          pattern = value && new RegExp(value.source.replaceAll(' ', '(?: > | )'), value.flags)
        },
      })
    },
  }
}

// The Vitest config StrykerJS runs (`pnpm test:mutation`): only the suites of the two areas that
// are mutated, `server/index` and `scripts/index`. They are plain Node suites, so the Nuxt project
// of `vitest.config.ts`, which boots a Nuxt app per run, is left out. A local tool, not a CI step.
export default defineConfig({
  plugins: [strykerNamesOnVitest5()],
  test: {
    include: ['tests/server/index/**/*.test.ts', 'tests/server/job/**/*.test.ts'],
    // The storage budget of a 3 500-game run. It reaches most of both areas, so StrykerJS would
    // repeat it for most mutants, and one pass over instrumented source takes about a minute.
    exclude: [...configDefaults.exclude, 'tests/server/job/similarPayload.test.ts'],
    setupFiles: ['tests/server/support/mutationRun.ts'],
    environment: 'node',
  },
})
