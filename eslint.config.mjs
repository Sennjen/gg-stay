import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt({
  ignores: ['**/__generated__/**', 'tests/fixtures/**'],
})
