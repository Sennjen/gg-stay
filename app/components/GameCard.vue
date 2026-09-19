<script setup lang="ts">
import type { GamesQuery } from '~/graphql/__generated__/operations'

const props = withDefaults(
  defineProps<{ game: GamesQuery['games']['items'][number]; eager?: boolean }>(),
  { eager: false },
)
const { t } = useI18n()
const localePath = useLocalePath()

const YEAR = /^(\d{4})-\d{2}-\d{2}/
const year = computed(() => props.game.released?.match(YEAR)?.[1] ?? null)
const hoverImage = computed(() => props.game.screenshots[0] ?? null)
</script>

<template>
  <article class="overflow-hidden rounded-card">
    <NuxtLink
      :to="localePath(`/games/${game.slug}`)"
      class="group block overflow-hidden rounded-card border border-line bg-surface-1 transition-colors duration-200 ease-out hover:border-fg-2 focus-visible:border-fg-2 focus-visible:outline-2"
    >
      <div class="relative aspect-video w-full overflow-hidden bg-surface-2">
        <NuxtImg
          v-if="game.cover"
          :src="game.cover.url"
          :alt="game.name"
          width="420"
          height="236"
          sizes="(max-width: 640px) 50vw, 420px"
          :loading="props.eager ? 'eager' : 'lazy'"
          class="h-full w-full object-cover transition-transform duration-200 ease-out group-hover:scale-[1.03] group-focus-visible:scale-[1.03]"
        />
        <div v-else class="flex h-full w-full items-center justify-center text-sm text-fg-2">
          {{ t('catalog.noCover') }}
        </div>
        <NuxtImg
          v-if="hoverImage"
          :src="hoverImage.url"
          alt=""
          aria-hidden="true"
          loading="lazy"
          class="absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-200 ease-out group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </div>
      <div class="p-3">
        <h3 class="line-clamp-2 font-semibold leading-snug text-fg">{{ game.name }}</h3>
        <p v-if="year" class="font-numeric mt-1 text-sm text-fg-2">{{ year }}</p>
        <p
          v-if="game.metacritic || game.platformFamilies.length"
          class="mt-2 flex flex-wrap items-center gap-2"
        >
          <MetacriticBadge v-if="game.metacritic" :score="game.metacritic" />
          <PlatformIcons v-if="game.platformFamilies.length" :families="game.platformFamilies" />
        </p>
      </div>
    </NuxtLink>
  </article>
</template>
