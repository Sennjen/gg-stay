<script setup lang="ts">
const { t } = useI18n()
const localePath = useLocalePath()
useSeoMeta({ title: () => t('home.title'), description: () => t('home.description') })
</script>

<template>
  <main>
    <h1 class="font-display-heading text-4xl text-fg">{{ t('home.title') }}</h1>
    <p class="mt-4 text-lg text-fg-2">{{ t('home.description') }}</p>
    <NuxtLink
      :to="localePath('/games')"
      class="mt-8 inline-block rounded-chip bg-accent px-5 py-3 text-on-accent focus-visible:outline-2"
    >
      {{ t('home.openCatalog') }}
    </NuxtLink>
  </main>
</template>
