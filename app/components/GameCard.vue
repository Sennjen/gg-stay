<script setup lang="ts">
import type { GamesQuery } from '~/graphql/__generated__/operations'

defineProps<{ game: GamesQuery['games']['items'][number] }>()
const { t } = useI18n()
const localePath = useLocalePath()
const { formatDate } = useFormatters()
</script>

<template>
  <article class="overflow-hidden rounded-lg border border-slate-200 bg-white">
    <NuxtLink :to="localePath(`/games/${game.slug}`)" class="block focus-visible:outline-2">
      <NuxtImg
        v-if="game.cover"
        :src="game.cover.url"
        :alt="game.name"
        width="420"
        height="236"
        sizes="(max-width: 640px) 50vw, 420px"
        class="aspect-video w-full object-cover"
      />
      <div
        v-else
        class="flex aspect-video w-full items-center justify-center bg-slate-100 text-sm text-slate-500"
      >
        {{ t('catalog.noCover') }}
      </div>
      <div class="p-3">
        <h3 class="font-semibold leading-snug">{{ game.name }}</h3>
        <p v-if="game.released" class="mt-1 text-sm text-slate-600">
          {{ formatDate(game.released) }}
        </p>
        <p class="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span
            v-if="game.metacritic"
            class="rounded bg-emerald-100 px-1.5 py-0.5 font-semibold text-emerald-900"
          >
            {{ game.metacritic }}
          </span>
          <span v-for="platform in game.platforms.slice(0, 4)" :key="platform.id">{{
            platform.name
          }}</span>
        </p>
      </div>
    </NuxtLink>
  </article>
</template>
