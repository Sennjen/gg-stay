<script setup lang="ts">
const { t } = useI18n()
</script>

<template>
  <div class="flex min-h-screen flex-col bg-ink text-fg">
    <AppHeader />

    <div class="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
      <slot />
    </div>

    <footer class="border-t border-line text-sm text-fg-2">
      <div class="mx-auto max-w-6xl px-4 py-4">
        <i18n-t keypath="footer.dataBy" tag="span">
          <template #rawg>
            <a
              href="https://rawg.io"
              target="_blank"
              rel="noopener noreferrer"
              class="underline underline-offset-4 hover:text-fg focus-visible:outline-2"
              >{{ t('footer.rawg') }}</a
            >
          </template>
          <template #steam>
            <a
              href="https://store.steampowered.com"
              target="_blank"
              rel="noopener noreferrer"
              class="underline underline-offset-4 hover:text-fg focus-visible:outline-2"
              >{{ t('footer.steam') }}</a
            >
          </template>
        </i18n-t>
        {{ t('footer.rights') }}
      </div>
    </footer>
  </div>
</template>
