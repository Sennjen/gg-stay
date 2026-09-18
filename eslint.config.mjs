import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  {
    ignores: ['**/__generated__/**', 'tests/fixtures/**'],
  },
  {
    // The catalog brief names this component `Pagination.vue`; it is a single, well-known
    // catalog primitive, not a generic HTML tag that risks colliding with a native element.
    files: ['app/components/Pagination.vue'],
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  },
)
