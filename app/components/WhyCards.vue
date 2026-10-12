<script setup lang="ts">
// The landing's positioning: a catalog made for Ukrainian players. Each card is one proof of it
// and names only what is live — the Ukrainian interface and localisation filter, Steam's hryvnia
// prices, the "made in Ukraine" shelf, and Gege. Prices from other stores are not promised here.
const { t } = useI18n()
const localePath = useLocalePath()

const CARDS = ['language', 'hryvnia', 'ukrainianGames', 'gege'] as const

const headingId = useId()
</script>

<template>
  <section :aria-labelledby="headingId">
    <h2 :id="headingId" class="font-display-heading text-2xl text-fg sm:text-3xl">
      {{ t('why.title') }}
    </h2>
    <p data-test="why-lead" class="mt-2 max-w-2xl text-fg-2">{{ t('why.lead') }}</p>
    <ul class="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <li v-for="card in CARDS" :key="card">
        <article class="flex h-full flex-col rounded-card border border-line bg-surface-1 p-6">
          <!-- Gege is his own icon: 40 px wide is a whole multiple of his grid and 26 px tall,
               level with the 28 px line icons beside him. -->
          <div v-if="card === 'gege'" class="flex h-7 items-center">
            <GegeMascot :size="40" :animated="false" />
          </div>
          <svg
            v-else
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
            <!-- The hryvnia sign: a reversed S crossed by two bars. -->
            <template v-else-if="card === 'hryvnia'">
              <path
                d="M7.5 8.5C7.5 6.4 9.3 5 12 5s4.5 1.2 4.5 3.1c0 1.5-1 2.4-2.7 3.3l-3.6 1.9c-1.7.9-2.7 1.8-2.7 3.3 0 1.9 1.8 3.1 4.5 3.1s4.5-1.3 4.5-3.3"
              />
              <path d="M4.5 10.5h15M4.5 13.5h15" />
            </template>
            <!-- A flag in two bands. -->
            <template v-else>
              <path d="M5 21V4" />
              <path d="M5 5h14v10H5" />
              <path d="M5 10h14" />
            </template>
          </svg>
          <h3 class="mt-4 font-semibold text-fg">{{ t(`why.cards.${card}.title`) }}</h3>
          <p class="mt-2 text-sm text-fg-2">{{ t(`why.cards.${card}.description`) }}</p>
          <p v-if="card === 'gege'" class="mt-auto pt-4 text-sm">
            <NuxtLink
              :to="localePath('/ask')"
              class="text-fg underline underline-offset-4 focus-visible:outline-2"
              >{{ t('why.cards.gege.action') }}</NuxtLink
            >
          </p>
        </article>
      </li>
    </ul>
  </section>
</template>
