<script setup lang="ts">
/**
 * One game of an answer, as a row: a small cover, the name, the reason it fits as the line a
 * visitor reads first, the facts under it and the price on the right. A row rather than a catalog
 * card because the reason is the point of the answer and needs the width, and because eight rows
 * read as one list where eight cards were four screens of covers.
 *
 * On a phone the cover shrinks to sit beside the name alone, and the reason, the facts and the
 * price each take the full width under them.
 */
import type { AskItem } from '~/utils/askAnswer'
import { ASK_ROW_IMAGE_SIZES } from '~/utils/rawgImage'

const props = withDefaults(defineProps<{ item: AskItem; eager?: boolean }>(), { eager: false })

const { t } = useI18n()
const localePath = useLocalePath()

const YEAR = /^(\d{4})-\d{2}-\d{2}/

const game = computed(() => props.item.card)
const year = computed(() => game.value.released?.match(YEAR)?.[1] ?? null)
const hasPlatforms = computed(() =>
  game.value.platformFamilies.some((family) => family !== 'OTHER'),
)
const hasMeta = computed(
  () => !!year.value || hasPlatforms.value || !!game.value.metacritic || game.value.madeInUkraine,
)
// A game outside the price index has neither a price nor a localisation flag: the block is left
// out, not filled with a placeholder.
const hasPrice = computed(
  () => !!game.value.price || !!(game.value.localisation?.text || game.value.localisation?.audio),
)
</script>

<template>
  <!-- The name is the row's one link, stretched over the whole row; the focus ring is drawn on the
       row, where the click lands. -->
  <article
    data-test="ask-row"
    class="group relative grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 rounded-card border border-line bg-surface-1 p-3 outline-offset-2 outline-accent transition-colors duration-200 ease-out hover:border-fg-2 has-[a:focus-visible]:outline-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-start sm:gap-x-4"
  >
    <div class="relative aspect-video w-full overflow-hidden rounded-lg bg-surface-2">
      <NuxtImg
        v-if="game.cover"
        :src="game.cover.url"
        alt=""
        width="160"
        height="90"
        :sizes="ASK_ROW_IMAGE_SIZES"
        :loading="eager ? 'eager' : 'lazy'"
        class="h-full w-full object-cover transition-transform duration-200 ease-out group-hover:scale-[1.03]"
      />
      <div
        v-else
        class="flex h-full w-full items-center justify-center px-1 text-center text-xs text-fg-2"
      >
        {{ t('catalog.noCover') }}
      </div>
    </div>

    <!-- One column beside the cover from `sm` up; on a phone its lines are the grid's own items,
         so the name stays beside the cover and the rest runs the full width under both. -->
    <div class="contents sm:block sm:min-w-0">
      <h3 data-test="card-title" class="min-w-0 font-semibold leading-snug break-words text-fg">
        <NuxtLink
          :to="localePath(`/games/${game.slug}`)"
          class="ask-row__link after:absolute after:inset-0 after:rounded-card"
          >{{ game.name }}</NuxtLink
        >
      </h3>
      <p v-if="item.reason" data-test="ask-reason" class="col-span-2 break-words text-fg sm:mt-1">
        {{ item.reason }}
      </p>
      <div
        v-if="hasMeta"
        data-test="ask-meta"
        class="col-span-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-2 sm:mt-2"
      >
        <span v-if="year" class="font-numeric">{{ year }}</span>
        <span v-if="year && hasPlatforms" aria-hidden="true">·</span>
        <PlatformIcons v-if="hasPlatforms" :families="game.platformFamilies" :max="3" />
        <MetacriticBadge v-if="game.metacritic" :score="game.metacritic" />
        <span
          v-if="game.madeInUkraine"
          data-test="made-in-ukraine"
          class="rounded-chip border border-line px-2 py-0.5 text-xs font-medium text-fg"
        >
          {{ t('card.madeInUkraine') }}
        </span>
      </div>
    </div>

    <div
      v-if="hasPrice"
      data-test="ask-price"
      class="col-span-2 flex flex-wrap items-center gap-2 sm:col-span-1 sm:flex-col sm:items-end sm:gap-1.5"
    >
      <PriceTag :price="game.price" />
      <LocalisationBadge :localisation="game.localisation" />
    </div>
  </article>
</template>

<style scoped>
/* The row draws the focus ring for its link (see the template). Written here rather than as a
   utility: the global `:focus-visible` rule in main.css is unlayered and outranks every utility. */
.ask-row__link:focus-visible {
  outline: none;
}
</style>
