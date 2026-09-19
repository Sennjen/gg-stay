<script setup lang="ts">
import type { GamesQuery } from '~/graphql/__generated__/operations'

const props = withDefaults(
  defineProps<{ game: GamesQuery['games']['items'][number]; eager?: boolean }>(),
  { eager: false },
)
const { t } = useI18n()
const localePath = useLocalePath()
const { formatDate } = useFormatters()
</script>

<template>
  <article class="overflow-hidden rounded-card border border-line bg-surface-1">
    <NuxtLink :to="localePath(`/games/${game.slug}`)" class="block focus-visible:outline-2">
      <NuxtImg
        v-if="game.cover"
        :src="game.cover.url"
        :alt="game.name"
        width="420"
        height="236"
        sizes="(max-width: 640px) 50vw, 420px"
        :loading="props.eager ? 'eager' : 'lazy'"
        class="aspect-video w-full object-cover"
      />
      <div
        v-else
        class="flex aspect-video w-full items-center justify-center bg-surface-2 text-sm text-fg-3"
      >
        {{ t('catalog.noCover') }}
      </div>
      <div class="p-3">
        <h3 class="font-semibold leading-snug text-fg">{{ game.name }}</h3>
        <p v-if="game.released" class="font-numeric mt-1 text-sm text-fg-2">
          {{ formatDate(game.released) }}
        </p>
        <p class="mt-2 flex flex-wrap items-center gap-2 text-xs text-fg-2">
          <span
            v-if="game.metacritic"
            class="font-numeric rounded bg-surface-2 px-1.5 py-0.5 font-semibold text-fg"
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
