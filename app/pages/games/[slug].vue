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
      class="text-sm underline-offset-4 hover:underline focus-visible:outline-2"
    >
      {{ t('game.backToCatalog') }}
    </NuxtLink>

    <StatesErrorState v-if="errorCode" class="mt-6" :code="errorCode" @retry="refresh()" />

    <article v-else-if="game" class="mt-4 grid gap-8 lg:grid-cols-[1fr_20rem]">
      <div>
        <h1 class="text-3xl font-bold">{{ game.name }}</h1>
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
          <h2 class="text-xl font-semibold">{{ t('game.about') }}</h2>
          <p class="mt-2 leading-relaxed whitespace-pre-line">{{ game.description }}</p>
        </section>
        <StoreLinks class="mt-8" :offers="game.stores" />
      </div>

      <dl class="h-fit space-y-3 rounded-lg border border-slate-200 p-4 text-sm">
        <div v-if="game.released">
          <dt class="text-slate-500">{{ t('game.released') }}</dt>
          <dd>{{ formatDate(game.released) }}</dd>
        </div>
        <div v-if="game.platforms.length">
          <dt class="text-slate-500">{{ t('game.platforms') }}</dt>
          <dd>{{ names(game.platforms) }}</dd>
        </div>
        <div v-if="game.genres.length">
          <dt class="text-slate-500">{{ t('game.genres') }}</dt>
          <dd>{{ names(game.genres) }}</dd>
        </div>
        <div v-if="game.gameModes.length">
          <dt class="text-slate-500">{{ t('game.gameModes') }}</dt>
          <dd>{{ game.gameModes.map((mode) => t(`gameModes.${mode}`)).join(', ') }}</dd>
        </div>
        <div v-if="game.ageRating">
          <dt class="text-slate-500">{{ t('game.ageRating') }}</dt>
          <dd>{{ t(`ageRatings.${game.ageRating}`) }}</dd>
        </div>
        <div v-if="game.playtime">
          <dt class="text-slate-500">{{ t('game.playtime') }}</dt>
          <dd>{{ t('game.hours', { count: game.playtime }) }}</dd>
        </div>
        <div v-if="game.metacritic">
          <dt class="text-slate-500">{{ t('game.metacritic') }}</dt>
          <dd>{{ game.metacritic }}</dd>
        </div>
        <div v-if="game.rating">
          <dt class="text-slate-500">{{ t('game.userRating') }}</dt>
          <dd>
            {{ game.rating.toFixed(1) }}
            <span v-if="game.ratingsCount" class="text-slate-500">
              ({{ t('game.ratingsCount', { count: formatNumber(game.ratingsCount) }) }})
            </span>
          </dd>
        </div>
        <div v-if="game.developers.length">
          <dt class="text-slate-500">{{ t('game.developers') }}</dt>
          <dd>{{ names(game.developers) }}</dd>
        </div>
        <div v-if="game.publishers.length">
          <dt class="text-slate-500">{{ t('game.publishers') }}</dt>
          <dd>{{ names(game.publishers) }}</dd>
        </div>
        <div v-if="game.website">
          <dt class="text-slate-500">{{ t('game.website') }}</dt>
          <dd>
            <a
              :href="game.website"
              target="_blank"
              rel="noopener noreferrer"
              class="break-all underline"
            >
              {{ game.website }}
            </a>
          </dd>
        </div>
      </dl>
    </article>
  </main>
</template>
