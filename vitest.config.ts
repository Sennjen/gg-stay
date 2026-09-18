import { defineConfig } from 'vitest/config'
import { defineVitestProject } from '@nuxt/test-utils/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'unit', include: ['tests/server/**/*.test.ts'], environment: 'node' },
      },
      await defineVitestProject({
        test: { name: 'nuxt', include: ['tests/app/**/*.test.ts'], environment: 'nuxt' },
      }),
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          environment: 'node',
          testTimeout: 180_000,
          hookTimeout: 180_000,
          passWithNoTests: true,
        },
      },
    ],
  },
})
