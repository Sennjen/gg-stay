<script setup lang="ts">
const { t } = useI18n()
const localePath = useLocalePath()
const newReleasesTo = { path: localePath('/games'), query: { sort: 'RELEASED_DESC' } }
</script>

<template>
  <footer class="border-t border-line">
    <div class="mx-auto max-w-6xl px-4 py-10">
      <div class="flex flex-col gap-8 sm:flex-row sm:justify-between">
        <div class="max-w-sm">
          <NuxtLink
            :to="localePath('/')"
            class="font-display-heading text-xl text-fg focus-visible:outline-2"
          >
            GG Stay
          </NuxtLink>
          <p class="mt-2 text-sm text-fg-2">{{ t('home.description') }}</p>
        </div>

        <div
          class="flex flex-col gap-4 sm:shrink-0 sm:flex-row sm:items-center sm:gap-6 sm:self-start"
        >
          <nav
            :aria-label="t('footer.nav')"
            class="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm sm:flex-nowrap"
          >
            <NuxtLink
              :to="localePath('/games')"
              class="text-fg underline-offset-4 hover:underline focus-visible:outline-2"
            >
              {{ t('nav.catalog') }}
            </NuxtLink>
            <NuxtLink
              :to="newReleasesTo"
              class="text-fg underline-offset-4 hover:underline focus-visible:outline-2"
            >
              {{ t('home.hero.newReleases') }}
            </NuxtLink>
            <a
              href="https://github.com/Sennjen/gg-stay"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1.5 text-fg underline-offset-4 hover:underline focus-visible:outline-2"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                width="16"
                height="16"
                fill="currentColor"
              >
                <path
                  d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.7-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.5 7.5 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 8 0Z"
                />
              </svg>
              {{ t('footer.github') }}
            </a>
          </nav>

          <LocaleSwitcher class="-ml-2 self-start sm:ml-0 sm:self-auto" />
        </div>
      </div>

      <div class="mt-8 border-t border-line pt-4 text-sm text-fg-2">
        <p>
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
        </p>
        <p class="mt-1">{{ t('footer.rights') }}</p>
      </div>
    </div>
  </footer>
</template>
