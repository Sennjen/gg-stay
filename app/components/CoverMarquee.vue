<script setup lang="ts">
import type { GamesQuery } from '~/graphql/__generated__/operations'

const props = defineProps<{
  games: GamesQuery['games']['items']
  animated: boolean
}>()

const localePath = useLocalePath()
const { t } = useI18n()

// Must match `.marquee-item`'s CSS `width` below — `sizes` drives which resized CDN variant
// the image provider serves, so declaring a larger size than the box is actually rendered at
// wastes bytes fetching a bigger variant than ever gets shown.
const COVER_WIDTH = 200
const COVER_HEIGHT = Math.round((COVER_WIDTH * 9) / 16)

// Pure CSS marquee: a duplicated track slides by exactly one set's width (-50%) in a seamless
// loop, paused via `:hover`/`:focus-within` in the <style> below. Touch has neither hover nor
// focus-within while a finger rests on the track, so an active touch is tracked explicitly.
const touching = ref(false)
function onTouchStart(event: PointerEvent) {
  if (event.pointerType === 'touch') touching.value = true
}
function onTouchEnd(event: PointerEvent) {
  if (event.pointerType === 'touch') touching.value = false
}
</script>

<template>
  <div class="marquee-viewport" :class="{ 'is-static': !props.animated }">
    <ul
      class="marquee-track"
      :class="{ 'is-animated': props.animated, 'is-touching': touching }"
      :aria-label="t('ring.scrollLabel')"
      @pointerdown="onTouchStart"
      @pointerup="onTouchEnd"
      @pointercancel="onTouchEnd"
    >
      <li v-for="game in props.games" :key="game.id" class="marquee-item">
        <NuxtLink :to="localePath(`/games/${game.slug}`)" class="block focus-visible:outline-2">
          <NuxtImg
            v-if="game.cover"
            :src="game.cover.url"
            :alt="game.name"
            :width="COVER_WIDTH"
            :height="COVER_HEIGHT"
            :sizes="`${COVER_WIDTH}px`"
            loading="lazy"
            class="aspect-video w-full rounded-card object-cover"
          />
          <div
            v-else
            class="flex aspect-video w-full items-center justify-center rounded-card bg-surface-2 text-xs text-fg-2"
          >
            {{ t('catalog.noCover') }}
          </div>
        </NuxtLink>
      </li>
      <template v-if="props.animated">
        <li
          v-for="game in props.games"
          :key="`dup-${game.id}`"
          class="marquee-item"
          aria-hidden="true"
        >
          <div class="block">
            <NuxtImg
              v-if="game.cover"
              :src="game.cover.url"
              alt=""
              :width="COVER_WIDTH"
              :height="COVER_HEIGHT"
              :sizes="`${COVER_WIDTH}px`"
              loading="lazy"
              class="aspect-video w-full rounded-card object-cover"
            />
            <div
              v-else
              class="flex aspect-video w-full items-center justify-center rounded-card bg-surface-2 text-xs text-fg-2"
            >
              {{ t('catalog.noCover') }}
            </div>
          </div>
        </li>
      </template>
    </ul>
  </div>
</template>

<style scoped>
.marquee-viewport {
  overflow: hidden;
  /* `CoverRing` centers this component as a flex item when it's used as the mobile/reduced-
     motion fallback; a flex item's main-axis size defaults to its shrink-to-fit content width
     otherwise, so the track would never get the full stage width to scroll across. */
  width: 100%;
}

.marquee-viewport.is-static {
  overflow-x: auto;
  scrollbar-width: none;
}
.marquee-viewport.is-static::-webkit-scrollbar {
  display: none;
}

.marquee-track {
  display: flex;
  gap: 1rem;
  width: max-content;
}

.marquee-viewport.is-static .marquee-track {
  scroll-snap-type: x mandatory;
}

.marquee-item {
  width: v-bind('`${COVER_WIDTH}px`');
  flex-shrink: 0;
}

.marquee-viewport.is-static .marquee-item {
  scroll-snap-align: start;
}

.marquee-track.is-animated {
  animation: marquee-scroll 40s linear infinite;
}

.marquee-track.is-animated:hover,
.marquee-track.is-animated:focus-within,
.marquee-track.is-animated.is-touching {
  animation-play-state: paused;
}

@keyframes marquee-scroll {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-50%);
  }
}
</style>
