<script setup lang="ts">
const { t } = useI18n()
const localePath = useLocalePath()
useSeoMeta({ title: () => t('home.title'), description: () => t('home.description') })
</script>

<template>
  <main class="mx-auto max-w-5xl px-4 py-16">
    <h1 class="text-4xl font-bold">{{ t('home.title') }}</h1>
    <p class="mt-4 text-lg text-slate-600">{{ t('home.description') }}</p>
    <NuxtLink
      :to="localePath('/games')"
      class="mt-8 inline-block rounded bg-slate-900 px-5 py-3 text-white focus-visible:outline-2"
    >
      {{ t('home.openCatalog') }}
    </NuxtLink>
  </main>
</template>
