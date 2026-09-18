<script setup lang="ts">
const { t } = useI18n()
const localePath = useLocalePath()
</script>

<template>
  <div class="flex min-h-screen flex-col bg-white text-slate-900">
    <header class="border-b border-slate-200">
      <div class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <NuxtLink :to="localePath('/')" class="text-lg font-bold focus-visible:outline-2"
          >GG Stay</NuxtLink
        >
        <div class="flex items-center gap-4">
          <NuxtLink
            :to="localePath('/games')"
            class="underline-offset-4 hover:underline focus-visible:outline-2"
            >{{ t('nav.catalog') }}</NuxtLink
          >
          <LocaleSwitcher />
        </div>
      </div>
    </header>

    <div class="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
      <slot />
    </div>

    <footer class="border-t border-slate-200 text-sm text-slate-600">
      <div class="mx-auto max-w-6xl px-4 py-4">
        {{ t('footer.dataBy') }}
        <a href="https://rawg.io" target="_blank" rel="noopener noreferrer" class="underline"
          >RAWG</a
        >.
        {{ t('footer.rights') }}
      </div>
    </footer>
  </div>
</template>
