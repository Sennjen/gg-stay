<script setup lang="ts">
import type { GameQuery } from '~/graphql/__generated__/operations'
import { hoursSince } from '~/utils/format'

const props = defineProps<{
  game: NonNullable<GameQuery['game']>
  /**
   * ISO timestamp of "now", computed once (server or first client render) and reused — see
   * `useState('game-page-now', ...)` in `pages/games/[slug].vue`. Never read directly with
   * `Date.now()` here: that would render a different "N hours ago" on the server than on the
   * client the moment a second passes between the two, which is exactly the kind of hydration
   * mismatch the design rules call out. Optional so existing callers/tests that never show a
   * price do not need to supply it.
   */
  now?: string
}>()
const { t } = useI18n()
const { formatDate, formatDecimal, formatNumber } = useFormatters()

// The scoreboard only ever shows Steam's price — "Де купити" is where every other store lives.
const steamOffer = computed(() => props.game.stores?.find((offer) => offer.store === 'steam'))
const steamPrice = computed(() => {
  const offer = steamOffer.value
  if (!offer || offer.priceUah == null) return null
  return {
    bestUah: offer.priceUah,
    regularUah: offer.regularPriceUah,
    discountPercent: offer.discountPercent ?? 0,
    isFree: false,
  }
})
const priceUpdatedHours = computed(() => {
  const updatedAt = steamOffer.value?.updatedAt
  return updatedAt && props.now ? hoursSince(updatedAt, props.now) : null
})

const localisationLabel = computed(() => {
  const localisation = props.game.localisation
  if (localisation?.audio) return t('game.localisationAudio')
  if (localisation?.text) return t('game.localisationText')
  return t('game.localisationNone')
})

// A single accessible name for the whole rating item ("Оцінка гравців: 4,6 з 5, 7 277 оцінок"),
// so it reads naturally as one phrase instead of the caption, star, value, scale and count being
// announced as separate fragments.
const ratingAriaLabel = computed(() => {
  const game = props.game
  if (!game.rating) return ''
  const base = `${t('game.userRating')}: ${formatDecimal(game.rating)} ${t('game.ratingScale')}`
  if (!game.ratingsCount) return base
  const count = t(
    'game.ratingsCount',
    { count: formatNumber(game.ratingsCount) },
    { plural: game.ratingsCount },
  )
  return `${base}, ${count}`
})
</script>

<template>
  <dl class="mt-4 flex flex-wrap items-start gap-x-6 gap-y-3">
    <div v-if="game.released" class="flex flex-col gap-0.5">
      <dt class="text-xs text-fg-2">{{ t('game.released') }}</dt>
      <dd class="text-fg-2">{{ formatDate(game.released) }}</dd>
    </div>
    <div v-if="game.metacritic" class="flex flex-col gap-0.5">
      <dt class="text-xs text-fg-2">{{ t('game.metacritic') }}</dt>
      <dd><MetacriticBadge :score="game.metacritic" /></dd>
    </div>
    <div v-if="game.rating" class="flex flex-col gap-0.5">
      <dt class="text-xs text-fg-2">{{ t('game.userRating') }}</dt>
      <dd class="flex items-baseline gap-1.5" :aria-label="ratingAriaLabel">
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="14"
          height="14"
          class="self-center text-fg"
        >
          <path
            fill="currentColor"
            d="M8 1.3l1.97 4.14 4.53.42-3.42 3.09 1.02 4.5L8 11.2l-4.1 2.25 1.02-4.5-3.42-3.09 4.53-.42L8 1.3z"
          />
        </svg>
        <span class="font-tabular text-fg">{{ formatDecimal(game.rating) }}</span>
        <span class="text-fg-2">{{ t('game.ratingScale') }}</span>
        <template v-if="game.ratingsCount">
          <span aria-hidden="true" class="text-fg-2">·</span>
          <i18n-t
            keypath="game.ratingsCount"
            tag="span"
            :plural="game.ratingsCount"
            class="text-fg-2"
          >
            <template #count
              ><span class="font-numeric">{{ formatNumber(game.ratingsCount) }}</span></template
            >
          </i18n-t>
        </template>
      </dd>
    </div>
    <div v-if="game.platformFamilies.length" class="flex flex-col gap-0.5">
      <dt class="text-xs text-fg-2">{{ t('game.platforms') }}</dt>
      <dd><PlatformIcons class="flex-wrap" :families="game.platformFamilies" /></dd>
    </div>
    <div v-if="steamPrice" class="flex flex-col gap-0.5">
      <dt class="text-xs text-fg-2">{{ t('game.priceLabel') }}</dt>
      <dd class="flex flex-col gap-0.5">
        <PriceTag :price="steamPrice" />
        <i18n-t
          v-if="priceUpdatedHours !== null"
          keypath="game.priceUpdated"
          tag="span"
          :plural="priceUpdatedHours"
          class="text-xs text-fg-2"
        >
          <template #count
            ><span class="font-numeric">{{ formatNumber(priceUpdatedHours) }}</span></template
          >
        </i18n-t>
      </dd>
    </div>
    <div class="flex flex-col gap-0.5">
      <dt class="text-xs text-fg-2">{{ t('game.localisationLabel') }}</dt>
      <dd class="text-fg">{{ localisationLabel }}</dd>
    </div>
  </dl>
</template>
