<script setup lang="ts">
import type { GamesQuery } from '~/graphql/__generated__/operations'

const props = defineProps<{
  games: GamesQuery['games']['items']
  title: string
}>()

const { t } = useI18n()
const localePath = useLocalePath()

// --- Geometry --------------------------------------------------------------
// One expensive motion loop, transform/opacity only: `perspective` on the stage plus
// `rotateY(baseAngle) translateZ(radius)` per cover gives size and tilt for free from the
// browser's 3D projection — no per-frame scale math needed. Only rotation (one CSS custom
// property on the list, inherited by every cover) and per-cover opacity (depth dimming) are
// written every frame, and both are compositor-only properties; nothing here reads layout.
const COVER_WIDTH = 200
const COVER_HEIGHT = Math.round((COVER_WIDTH * 9) / 16)
const DEGREES_PER_MS = 360 / 75_000 // one revolution every 75s — slow and calm, not a carousel
const DRAG_SENSITIVITY = 0.3 // degrees rotated per pixel dragged
const DRAG_THRESHOLD_PX = 6
const SNAP_EASE = 0.006 // per-ms easing factor when rotating a focused cover to the front

const count = computed(() => props.games.length)
const radius = computed(() =>
  count.value > 1
    ? Math.max(260, Math.round((count.value * (COVER_WIDTH + 32)) / (2 * Math.PI)))
    : 0,
)

function baseAngle(index: number): number {
  return count.value ? (index * 360) / count.value : 0
}

// --- Mode: ring (desktop, motion allowed) vs marquee (< 768px, or reduced motion) ----------
// Rendered client-only by the consumer (`<ClientOnly>` in Phase B), so there is no SSR markup
// to keep in sync here; still, the decision is only made in `onMounted` per the brief, and the
// initial render always matches what a non-reduced-motion desktop visitor sees.
const mode = ref<'ring' | 'marquee'>('ring')
const marqueeAnimated = ref(true)
let reducedMql: MediaQueryList | null = null
let narrowMql: MediaQueryList | null = null

function evaluateMode() {
  const reduced = reducedMql?.matches ?? false
  const narrow = narrowMql?.matches ?? false
  if (reduced) {
    mode.value = 'marquee'
    marqueeAnimated.value = false
  } else if (narrow) {
    mode.value = 'marquee'
    marqueeAnimated.value = true
  } else {
    mode.value = 'ring'
  }
  updateRunState()
}

// --- Rotation state (kept outside Vue's reactivity: it changes every frame) ----------------
let rotationDeg = 0
let targetRotation: number | null = null
let rafId: number | null = null
let lastTimestamp: number | null = null

const ringListEl = ref<HTMLUListElement | null>(null)
const linkRefs = ref<(HTMLAnchorElement | null)[]>([])
function setLinkRef(el: unknown, index: number) {
  const node = el as { $el?: HTMLAnchorElement } | HTMLAnchorElement | null
  linkRefs.value[index] =
    node && '$el' in node ? (node.$el ?? null) : (node as HTMLAnchorElement | null)
}

const announcedIndex = ref<number | null>(null)
const announcedName = computed(() =>
  announcedIndex.value !== null ? (props.games[announcedIndex.value]?.name ?? '') : '',
)

function shortestDiff(target: number, current: number): number {
  let diff = (target - current) % 360
  if (diff > 180) diff -= 360
  if (diff < -180) diff += 360
  return diff
}

function applyRotation() {
  const list = ringListEl.value
  if (!list) return
  list.style.setProperty('--ring-rotation', `${rotationDeg}deg`)
  const items = list.children
  for (let i = 0; i < items.length; i++) {
    const angle = baseAngle(i) + rotationDeg
    const cos = Math.cos((angle * Math.PI) / 180)
    const depth = 0.35 + 0.65 * ((cos + 1) / 2)
    ;(items[i] as HTMLElement).style.setProperty('--depth', depth.toFixed(3))
  }
}

// --- Pause reasons -----------------------------------------------------------------------
const isHovered = ref(false)
const isFocusWithin = ref(false)
const isDragging = ref(false)
const isVisible = ref(true)
const isTabHidden = ref(false)

function shouldRun(): boolean {
  return (
    mode.value === 'ring' &&
    count.value > 1 &&
    !isHovered.value &&
    !isFocusWithin.value &&
    !isDragging.value &&
    isVisible.value &&
    !isTabHidden.value
  )
}

function tick(timestamp: number) {
  if (lastTimestamp === null) lastTimestamp = timestamp
  const dt = timestamp - lastTimestamp
  lastTimestamp = timestamp

  if (targetRotation !== null) {
    const diff = shortestDiff(targetRotation, rotationDeg)
    if (Math.abs(diff) < 0.3) {
      rotationDeg = targetRotation
      targetRotation = null
    } else {
      rotationDeg += diff * Math.min(1, dt * SNAP_EASE)
    }
  } else {
    rotationDeg -= dt * DEGREES_PER_MS
  }
  applyRotation()
  rafId = requestAnimationFrame(tick)
}

function updateRunState() {
  const running = rafId !== null
  const wanted = shouldRun()
  if (wanted && !running) {
    lastTimestamp = null
    rafId = requestAnimationFrame(tick)
  } else if (!wanted && running) {
    cancelAnimationFrame(rafId!)
    rafId = null
  }
}

// --- Hover ---------------------------------------------------------------------------------
function onPointerEnter() {
  isHovered.value = true
  updateRunState()
}
function onPointerLeave() {
  isHovered.value = false
  updateRunState()
}

// --- Focus: pause and rotate the focused cover to the front --------------------------------
function focusToFront(index: number) {
  targetRotation = -baseAngle(index)
  announcedIndex.value = index
  updateRunState()
}

function onFocusIn(event: FocusEvent) {
  const target = event.target as HTMLElement
  const link = target.closest<HTMLElement>('[data-ring-index]')
  if (!link) return
  isFocusWithin.value = true
  focusToFront(Number(link.dataset.ringIndex))
  resetStageScroll()
}

// A cover that hasn't eased to the front yet is a transformed, off-angle box — the browser's
// built-in "scroll the newly focused element into view" behaviour could otherwise try to reveal
// it by scrolling this container. `.ring-stage` uses `overflow: clip` rather than `hidden`
// specifically so it never becomes a scroll container in the first place (unlike `hidden`,
// `clip` establishes no scroll port at all — verified directly: `scrollLeft`/`scrollTop` stay 0
// no matter how focus moves around the ring, native Tab included), which is what actually stops
// this rather than fighting it after the fact. This reset is kept as cheap, harmless
// defense-in-depth in case that ever changes.
function resetStageScroll() {
  const stage = stageEl.value
  if (!stage) return
  if (stage.scrollLeft !== 0) stage.scrollLeft = 0
  if (stage.scrollTop !== 0) stage.scrollTop = 0
}

function onFocusOut(event: FocusEvent) {
  const next = event.relatedTarget as Node | null
  if (next && ringListEl.value?.contains(next)) return
  isFocusWithin.value = false
  updateRunState()
}

// --- Keyboard: ArrowLeft/ArrowRight step the ring, moving real DOM focus -------------------
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
  if (!count.value) return
  event.preventDefault()
  const current = announcedIndex.value ?? 0
  const next =
    event.key === 'ArrowRight'
      ? (current + 1) % count.value
      : (current - 1 + count.value) % count.value
  // `preventScroll`: the target cover hasn't eased to the front yet (that happens via the
  // rotation this focus triggers, in `onFocusIn`), so its current, off-angle transformed
  // position must never drive the browser's default focus-scroll behaviour.
  linkRefs.value[next]?.focus({ preventScroll: true })
}

// --- Pointer drag: rotate freely; a drag must not fire the trailing click ------------------
let activePointerId: number | null = null
let dragStartX = 0
let dragStartRotation = 0
let dragged = false
let suppressNextClick = false

function onPointerDown(event: PointerEvent) {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  activePointerId = event.pointerId
  dragStartX = event.clientX
  dragStartRotation = rotationDeg
  dragged = false
  targetRotation = null
  isDragging.value = true
  updateRunState()
  const list = ringListEl.value
  if (list && typeof list.setPointerCapture === 'function') {
    try {
      list.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture is a progressive enhancement; ignore environments without it.
    }
  }
}

function onPointerMove(event: PointerEvent) {
  if (activePointerId !== event.pointerId) return
  const dx = event.clientX - dragStartX
  if (Math.abs(dx) > DRAG_THRESHOLD_PX) dragged = true
  rotationDeg = dragStartRotation + dx * DRAG_SENSITIVITY
  applyRotation()
}

function endDrag(event: PointerEvent) {
  if (activePointerId !== event.pointerId) return
  activePointerId = null
  isDragging.value = false
  if (dragged) suppressNextClick = true
  updateRunState()
}

function onRingClickCapture(event: MouseEvent) {
  if (suppressNextClick) {
    suppressNextClick = false
    event.preventDefault()
    event.stopPropagation()
  }
}

// --- Visibility: pause off-screen and while the tab is hidden ------------------------------
const stageEl = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

function onVisibilityChange() {
  isTabHidden.value = document.visibilityState === 'hidden'
  updateRunState()
}

onMounted(() => {
  reducedMql = window.matchMedia('(prefers-reduced-motion: reduce)')
  narrowMql = window.matchMedia('(max-width: 767px)')
  reducedMql.addEventListener('change', evaluateMode)
  narrowMql.addEventListener('change', evaluateMode)
  evaluateMode()

  document.addEventListener('visibilitychange', onVisibilityChange)

  if (stageEl.value && 'IntersectionObserver' in window) {
    observer = new IntersectionObserver(
      (entries) => {
        isVisible.value = entries[0]?.isIntersecting ?? true
        updateRunState()
      },
      { threshold: 0 },
    )
    observer.observe(stageEl.value)
  }

  applyRotation()
  updateRunState()
})

onBeforeUnmount(() => {
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = null
  reducedMql?.removeEventListener('change', evaluateMode)
  narrowMql?.removeEventListener('change', evaluateMode)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  observer?.disconnect()
  observer = null
})
</script>

<script lang="ts">
// Reserved height for the ring, shared with the `<ClientOnly>` placeholder that will wrap this
// component in Phase B so the fallback matches exactly and nothing shifts once it mounts.
export const RING_HEIGHT_CLASS = 'h-[240px] sm:h-[280px]'
</script>

<template>
  <div ref="stageEl" class="ring-stage relative" :class="RING_HEIGHT_CLASS">
    <ul
      v-if="mode === 'ring'"
      ref="ringListEl"
      class="ring-list"
      :aria-label="props.title"
      @pointerenter="onPointerEnter"
      @pointerleave="onPointerLeave"
      @focusin="onFocusIn"
      @focusout="onFocusOut"
      @keydown="onKeydown"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @click.capture="onRingClickCapture"
    >
      <li
        v-for="(game, index) in props.games"
        :key="game.id"
        class="ring-item"
        :style="{ '--base-angle': `${baseAngle(index)}deg` }"
      >
        <NuxtLink
          :ref="(el) => setLinkRef(el, index)"
          :to="localePath(`/games/${game.slug}`)"
          :data-ring-index="index"
          class="ring-link block h-full w-full overflow-hidden rounded-card focus-visible:outline-2"
        >
          <NuxtImg
            v-if="game.cover"
            :src="game.cover.url"
            :alt="game.name"
            :width="COVER_WIDTH"
            :height="COVER_HEIGHT"
            :sizes="`${COVER_WIDTH}px`"
            loading="lazy"
            class="h-full w-full object-cover"
          />
          <div
            v-else
            class="flex h-full w-full items-center justify-center bg-surface-2 text-xs text-fg-2"
          >
            {{ t('catalog.noCover') }}
          </div>
        </NuxtLink>
      </li>
    </ul>

    <CoverMarquee v-else :games="props.games" :animated="marqueeAnimated" />

    <p class="sr-only" role="status" aria-live="polite">
      {{ announcedName ? t('ring.current', { name: announcedName }) : '' }}
    </p>
  </div>
</template>

<style scoped>
.ring-stage {
  /* Covers well off to the side rotate far enough round the ring that their transformed box
     extends past the stage's own edges — real content, not a bug in itself, but it must not
     grow the page's scrollable area (a global `overflow-x: clip` on <html> is not a substitute
     for this on its own — verified directly: it does not block a raw `scrollTo()` call on the
     root element, so the ring contains its own overflow instead of leaning on that page-level
     rule). `clip` rather than `hidden` here: unlike `hidden`, `clip` never establishes a scroll
     container at all on a normal (non-root) element, so there's no `scrollLeft`/`scrollTop` for
     anything — including the browser's own focus-driven "scroll into view" behaviour for a
     Tab-focused, off-angle cover — to move in the first place (verified directly: `scrollLeft`
     stays 0 through focus changes with `clip`, where it visibly drifted with `hidden`). */
  overflow: clip;
  perspective: 1400px;
  /* The mobile/reduced-motion `CoverMarquee` fallback is shorter than the reserved ring
     height (which is sized for the ring's own, taller covers); center it instead of leaving
     it pinned to the top with empty space below. The ring's own `<ul>` has an explicit
     height that fills the stage either way, so this has no effect on it. */
  display: flex;
  align-items: center;
  justify-content: center;
}

.ring-list {
  position: relative;
  height: 100%;
  width: 100%;
  list-style: none;
  margin: 0;
  padding: 0;
  transform-style: preserve-3d;
  touch-action: pan-y;
}

.ring-item {
  position: absolute;
  top: 50%;
  left: 50%;
  width: v-bind('`${COVER_WIDTH}px`');
  height: v-bind('`${COVER_HEIGHT}px`');
  margin-top: v-bind('`${-COVER_HEIGHT / 2}px`');
  margin-left: v-bind('`${-COVER_WIDTH / 2}px`');
  transform: rotateY(calc(var(--base-angle, 0deg) + var(--ring-rotation, 0deg)))
    translateZ(v-bind('`${radius}px`'));
  opacity: var(--depth, 1);
}

.ring-link {
  background-color: var(--color-surface-2);
}
</style>
