<script setup lang="ts">
const { t } = useI18n()
</script>

<template>
  <div class="flex min-h-screen flex-col bg-ink text-fg">
    <a
      href="#main-content"
      class="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-50 focus-visible:rounded-chip focus-visible:bg-accent focus-visible:px-4 focus-visible:py-2 focus-visible:text-on-accent focus-visible:outline-2"
    >
      {{ t('nav.skipToContent') }}
    </a>

    <AppHeader />

    <!-- The one `<main>` of every route, and the skip link's target: pages render sections into
         it rather than their own landmark, so nothing a page renders can end up outside a
         landmark and no two `<main>` elements can nest. -->
    <main id="main-content" tabindex="-1" class="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
      <slot />
    </main>

    <AppFooter />
  </div>
</template>
