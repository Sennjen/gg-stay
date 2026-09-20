<script setup lang="ts">
// Only what is true today: Ukrainian interface, deep filters, RAWG data. No prices, no
// localisation-filter claims (see DESIGN.md "Copy" section).
const { t } = useI18n()

const CARDS = ['language', 'filters', 'stores'] as const

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
            <template v-if="card === 'language'">
              <path d="M4 5h16v11H11l-4.5 4v-4H4z" />
              <path d="M8 9h8M8 12.5h5" />
            </template>
            <template v-else-if="card === 'filters'">
              <path d="M4 6h16M4 12h16M4 18h16" />
              <circle cx="8" cy="6" r="2" fill="currentColor" stroke="none" />
              <circle cx="16" cy="12" r="2" fill="currentColor" stroke="none" />
              <circle cx="10" cy="18" r="2" fill="currentColor" stroke="none" />
            </template>
            <template v-else>
              <path d="M5 8h14l-1 12H6z" />
              <path d="M9 8V6.5a3 3 0 0 1 6 0V8" />
            </template>
          </svg>
          <h3 class="mt-4 font-semibold text-fg">{{ t(`why.cards.${card}.title`) }}</h3>
          <p class="mt-2 text-sm text-fg-2">{{ t(`why.cards.${card}.description`) }}</p>
        </article>
      </li>
    </ul>
  </section>
</template>
