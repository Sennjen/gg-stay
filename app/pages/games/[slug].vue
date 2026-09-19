<script setup lang="ts">
import { GameDocument } from '~/graphql/__generated__/operations'
import { safeExternalUrl } from '#shared/url'
import { splitParagraphs } from '~/utils/format'

const route = useRoute()
const { t, locale } = useI18n()
const localePath = useLocalePath()
const store = useFiltersStore()

const slug = computed(() => String(route.params.slug))
const { data, errorCode, refresh } = await useGql(GameDocument, () => ({
  slug: slug.value,
  locale: locale.value,
}))

if (errorCode.value === 'NOT_FOUND') {
  // Real HTTP 404 during SSR; renders app/error.vue, which sets noindex.
  throw createError({ statusCode: 404, statusMessage: 'Game not found', fatal: true })
}

const game = computed(() => data.value?.game ?? null)
// Defence in depth: the mapper already refuses a non-http(s) `website`, but the check belongs
// next to the `:href` too — Vue does not sanitise `href`, and this value is publisher-submitted.
const website = computed(() => safeExternalUrl(game.value?.website))
const names = (list?: { name: string }[]) => (list ?? []).map((entry) => entry.name).join(', ')
const localizedDescription = computed(() => game.value?.localizedDescription ?? null)
const descriptionParagraphs = computed(() => splitParagraphs(localizedDescription.value?.text))
const isSteamDescription = computed(() => localizedDescription.value?.source === 'STEAM')

const description = computed(() => {
  const text = localizedDescription.value?.text.replace(/\s+/g, ' ').trim()
  if (text) return text.length > 160 ? `${text.slice(0, 157)}…` : text
  return t('game.metaFallback', { name: game.value?.name ?? '' })
})

useSeoMeta({
  title: () => (game.value ? `${game.value.name} — GG Stay` : 'GG Stay'),
  description: () => description.value,
  ogTitle: () => game.value?.name,
  ogDescription: () => description.value,
  ogImage: () => game.value?.cover?.url,
})
</script>

<template>
  <main>
    <NuxtLink
      :to="{ path: localePath('/games'), query: store.lastCatalogQuery }"
      class="text-sm text-fg-2 underline-offset-4 hover:text-fg hover:underline focus-visible:outline-2"
    >
      {{ t('game.backToCatalog') }}
    </NuxtLink>

    <StatesErrorState v-if="errorCode" class="mt-6" :code="errorCode" @retry="refresh()" />

    <article v-else-if="game" class="mt-4">
      <GameHero :name="game.name" :cover-url="game.cover?.url ?? null">
        <GameScoreboard :game="game" />
      </GameHero>

      <div class="mt-8 grid gap-8 lg:grid-cols-[1fr_20rem]">
        <div>
          <section v-if="descriptionParagraphs.length">
            <div class="flex items-baseline gap-2">
              <h2 class="font-display-heading text-xl text-fg">{{ t('game.about') }}</h2>
              <span v-if="isSteamDescription" class="text-sm text-fg-2">{{
                t('game.descriptionSourceSteam')
              }}</span>
            </div>
            <div
              :lang="localizedDescription?.language"
              class="mt-2 max-w-prose space-y-4 leading-relaxed text-fg-2"
            >
              <p v-for="(paragraph, index) in descriptionParagraphs" :key="index">
                {{ paragraph }}
              </p>
            </div>
          </section>

          <ScreenshotGallery class="mt-8" :images="game.screenshots" :title="game.name" />

          <StoreLinks class="mt-8" :offers="game.stores" />
        </div>

        <dl class="h-fit space-y-3 rounded-card border border-line bg-surface-1 p-4 text-sm">
          <div v-if="game.genres.length">
            <dt class="text-fg-2">{{ t('game.genres') }}</dt>
            <dd>{{ names(game.genres) }}</dd>
          </div>
          <div v-if="game.gameModes.length">
            <dt class="text-fg-2">{{ t('game.gameModes') }}</dt>
            <dd>{{ game.gameModes.map((mode) => t(`gameModes.${mode}`)).join(', ') }}</dd>
          </div>
          <div v-if="game.ageRating">
            <dt class="text-fg-2">{{ t('game.ageRating') }}</dt>
            <dd>{{ t(`ageRatings.${game.ageRating}`) }}</dd>
          </div>
          <div v-if="game.playtime">
            <dt class="text-fg-2">{{ t('game.playtime') }}</dt>
            <dd>
              <i18n-t keypath="game.hours" tag="span">
                <template #count
                  ><span class="font-numeric">{{ game.playtime }}</span></template
                >
              </i18n-t>
            </dd>
          </div>
          <div v-if="game.developers.length">
            <dt class="text-fg-2">{{ t('game.developers') }}</dt>
            <dd>{{ names(game.developers) }}</dd>
          </div>
          <div v-if="game.publishers.length">
            <dt class="text-fg-2">{{ t('game.publishers') }}</dt>
            <dd>{{ names(game.publishers) }}</dd>
          </div>
          <div v-if="website">
            <dt class="text-fg-2">{{ t('game.website') }}</dt>
            <dd>
              <a
                :href="website"
                target="_blank"
                rel="noopener noreferrer"
                class="break-all text-fg underline underline-offset-4 hover:text-fg-2"
              >
                {{ website }}
              </a>
            </dd>
          </div>
        </dl>
      </div>
    </article>
  </main>
</template>
