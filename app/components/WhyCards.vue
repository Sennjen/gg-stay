<script setup lang="ts">
// Only what is true today: Ukrainian interface, deep filters, RAWG data. No prices, no
// localisation-filter claims (see DESIGN.md "Copy" section).
const { t } = useI18n()

const CARDS = ['interface', 'filters', 'data'] as const

const headingId = useId()
</script>

<template>
  <section :aria-labelledby="headingId">
    <h2 :id="headingId" class="font-display-heading text-2xl text-fg sm:text-3xl">
      {{ t('why.title') }}
    </h2>
    <ul class="mt-6 grid gap-4 sm:grid-cols-3">
      <li v-for="card in CARDS" :key="card">
        <article class="h-full rounded-card border border-line bg-surface-1 p-6">
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            width="28"
            height="28"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="text-fg-2"
          >
            <template v-if="card === 'interface'">
              <path d="M4 5.5h16M4 12h16M4 18.5h9" />
              <path d="M9 5.5 6.5 18.5" />
            </template>
            <template v-else-if="card === 'filters'">
              <path d="M4 6h16M4 12h16M4 18h16" />
              <circle cx="8" cy="6" r="2" fill="currentColor" stroke="none" />
              <circle cx="16" cy="12" r="2" fill="currentColor" stroke="none" />
              <circle cx="10" cy="18" r="2" fill="currentColor" stroke="none" />
            </template>
            <template v-else>
              <ellipse cx="12" cy="6" rx="8" ry="3" />
              <path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
              <path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
            </template>
          </svg>
          <h3 class="mt-4 font-semibold text-fg">{{ t(`why.cards.${card}.title`) }}</h3>
          <p class="mt-2 text-sm text-fg-2">{{ t(`why.cards.${card}.description`) }}</p>
        </article>
      </li>
    </ul>
  </section>
</template>
