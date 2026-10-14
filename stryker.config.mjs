// Mutation testing for the two largest areas of the suite, run by hand with `pnpm test:mutation`.
// It answers two questions a line-coverage number cannot: which rules of the code no test asserts
// (the mutants that survive), and which tests assert nothing the others do not (the tests whose
// removal leaves the set of killed mutants unchanged). It is not part of CI: a run takes minutes.
export default {
  // Named, because pnpm does not hoist the runner next to the core, where the default
  // `@stryker-mutator/*` lookup searches.
  plugins: ['@stryker-mutator/vitest-runner'],
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.mutation.config.ts',
    // Per-test coverage already narrows each mutant to the tests that reach it. Vitest's own
    // "related files" filter follows static imports only and would miss `run.test.ts`, which
    // reaches a module through `await import()`.
    related: false,
  },
  mutate: ['server/index/**/*.ts', 'scripts/index/**/*.ts'],
  // Every test that kills a mutant is recorded, not only the first. Without it `killedBy` in the
  // JSON report names one test per mutant and says nothing about which tests repeat each other.
  disableBail: true,
  // The sandbox the suites run in is a copy of the repository. Left out of it: what the suites of
  // the two areas never read, the dot-files of the root among it. Brought back into it: the
  // tsconfig files in `.nuxt`, a directory StrykerJS skips by default. The root `tsconfig.json`
  // only references them, and Vite cannot transform a file without them. Run `pnpm nuxt prepare`
  // first if `.nuxt` is missing.
  ignorePatterns: [
    '/.*',
    '/.nuxt/**',
    '!/.nuxt/tsconfig*.json',
    '/app',
    '/docs',
    '/playwright-report',
    '/public',
    '/test-results',
  ],
  // A mutant run is abandoned after the time its tests took unmutated, times 1.5, plus this. It
  // has to outlast the fifteen seconds a test is given in such a run (`mutationRun.ts`): a mutant
  // that leaves one test waiting for ever is then killed by that test, and the report names it.
  timeoutMS: 20_000,
  reporters: ['progress', 'clear-text', 'html', 'json'],
  clearTextReporter: { logTests: false, reportTests: false },
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  tempDirName: '.stryker-tmp',
  // Removed after a failed run as well.
  cleanTempDir: 'always',
  thresholds: { high: 80, low: 60, break: null },
}
