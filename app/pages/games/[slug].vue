<script setup lang="ts">
import { GameDocument } from '~/graphql/__generated__/operations'

const route = useRoute()
const { t } = useI18n()
const localePath = useLocalePath()
const { formatDate, formatNumber } = useFormatters()
const store = useFiltersStore()

const slug = computed(() => String(route.params.slug))
const { data, errorCode, refresh } = await useGql(GameDocument, () => ({ slug: slug.value }))

if (errorCode.value === 'NOT_FOUND') {
  // Real HTTP 404 during SSR; renders app/error.vue, which sets noindex.
  throw createError({ statusCode: 404, statusMessage: 'Game not found', fatal: true })
}

const game = computed(() => data.value?.game ?? null)
const names = (list?: { name: string }[]) => (list ?? []).map((entry) => entry.name).join(', ')

const description = computed(() => {
  const text = game.value?.description?.replace(/\s+/g, ' ').trim()
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

    <article v-else-if="game" class="mt-4 grid gap-8 lg:grid-cols-[1fr_20rem]">
      <div>
        <h1 class="font-display-heading text-3xl text-fg">{{ game.name }}</h1>
        <NuxtImg
          v-if="game.cover"
          :src="game.cover.url"
          :alt="game.name"
          width="1280"
          height="720"
          sizes="(max-width: 1024px) 100vw, 800px"
          class="mt-4 aspect-video w-full rounded-lg object-cover"
        />
        <section v-if="game.description" class="mt-6">
          <h2 class="font-display-heading text-xl text-fg">{{ t('game.about') }}</h2>
          <p class="mt-2 leading-relaxed whitespace-pre-line text-fg-2">{{ game.description }}</p>
        </section>
        <StoreLinks class="mt-8" :offers="game.stores" />
      </div>

      <dl class="h-fit space-y-3 rounded-card border border-line bg-surface-1 p-4 text-sm">
        <div v-if="game.released">
          <dt class="text-fg-2">{{ t('game.released') }}</dt>
          <dd>{{ formatDate(game.released) }}</dd>
        </div>
        <div v-if="game.platforms.length">
          <dt class="text-fg-2">{{ t('game.platforms') }}</dt>
          <dd>{{ names(game.platforms) }}</dd>
        </div>
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
        <div v-if="game.metacritic">
          <dt class="text-fg-2">{{ t('game.metacritic') }}</dt>
          <dd class="font-numeric">{{ game.metacritic }}</dd>
        </div>
        <div v-if="game.rating">
          <dt class="text-fg-2">{{ t('game.userRating') }}</dt>
          <dd>
            <span class="font-numeric">{{ game.rating.toFixed(1) }}</span>
            <span v-if="game.ratingsCount" class="text-fg-2">
              (<i18n-t keypath="game.ratingsCount" tag="span">
                <template #count
                  ><span class="font-numeric">{{ formatNumber(game.ratingsCount) }}</span></template
                > </i18n-t
              >)
            </span>
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
        <div v-if="game.website">
          <dt class="text-fg-2">{{ t('game.website') }}</dt>
          <dd>
            <a
              :href="game.website"
              target="_blank"
              rel="noopener noreferrer"
              class="break-all text-fg underline underline-offset-4 hover:text-fg-2"
            >
              {{ game.website }}
            </a>
          </dd>
        </div>
      </dl>
    </article>
  </main>
</template>
