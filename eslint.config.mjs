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
  {
    // Prettier always self-closes void HTML elements (e.g. `<input />`) but leaves normal
    // elements and components at ESLint's defaults; align the rule with what Prettier emits
    // instead of fighting it (`pnpm format` would just undo a hand-aligned fix otherwise).
    rules: {
      'vue/html-self-closing': [
        'warn',
        {
          html: { void: 'always', normal: 'always', component: 'always' },
          svg: 'always',
          math: 'always',
        },
      ],
    },
  },
)
