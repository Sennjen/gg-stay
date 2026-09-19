<script setup lang="ts">
import type { GameQuery } from '~/graphql/__generated__/operations'

defineProps<{ game: NonNullable<GameQuery['game']> }>()
const { t } = useI18n()
const { formatDate, formatDecimal, formatNumber } = useFormatters()
</script>

<template>
  <dl class="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
    <div v-if="game.released" class="flex items-center gap-1.5">
      <dt class="sr-only">{{ t('game.released') }}</dt>
      <dd class="text-fg-2">{{ formatDate(game.released) }}</dd>
    </div>
    <div v-if="game.metacritic" class="flex items-center gap-1.5">
      <dt class="sr-only">{{ t('game.metacritic') }}</dt>
      <dd><MetacriticBadge :score="game.metacritic" /></dd>
    </div>
    <div v-if="game.rating" class="flex items-center gap-1.5">
      <dt class="sr-only">{{ t('game.userRating') }}</dt>
      <dd class="flex items-baseline gap-1">
        <span class="font-numeric text-fg">{{ formatDecimal(game.rating) }}</span>
        <span v-if="game.ratingsCount" class="text-fg-2">
          (<i18n-t keypath="game.ratingsCount" tag="span">
            <template #count
              ><span class="font-numeric">{{ formatNumber(game.ratingsCount) }}</span></template
            > </i18n-t
          >)
        </span>
      </dd>
    </div>
    <div v-if="game.platformFamilies.length" class="flex items-center gap-1.5">
      <dt class="sr-only">{{ t('game.platforms') }}</dt>
      <dd><PlatformIcons :families="game.platformFamilies" /></dd>
    </div>
  </dl>
</template>
