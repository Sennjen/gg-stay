<script setup lang="ts">
import type Hls from 'hls.js'

// Rendered only inside a <ClientOnly> wrapper, and only after the page goes idle, so this
// component never competes with the hero poster (the LCP element) for bandwidth. It also
// self-guards against a narrow viewport, a slow or metered connection, `prefers-reduced-motion`
// and Save-Data, in case a caller mounts it directly without pre-checking those (see the parent's
// own `v-if="clipUrl"` guard). When any guard trips, nothing is created and nothing is fetched:
// the poster's slow zoom is the whole hero, which is what a phone should get.
const props = defineProps<{ clipUrl: string; paused: boolean }>()
const emit = defineEmits<{ 'update:paused': [value: boolean] }>()
const { t } = useI18n()

// Steam trailers are served as HLS master playlists (see docs/specs/2026-09-19-redesign-design.md
// and the PR brief): the RAWG mp4 clips this component already supported keep working unchanged.
const HLS_MAX_LEVEL_HEIGHT = 720

// A trailer is several MB. Below this width the hero is a phone-sized box where the poster reads
// just as well, and the bytes are far more likely to be metered.
const MIN_VIDEO_VIEWPORT_PX = 768

function isHlsUrl(url: string): boolean {
  const withoutQuery = url.split('?')[0] ?? url
  return withoutQuery.endsWith('.m3u8')
}

/** Safari plays HLS natively; every other engine needs hls.js. Checked against a throwaway
 * element rather than the real one so the strategy is known before the video first renders,
 * instead of flipping the `src` binding a moment after mount. */
function needsHlsJs(url: string): boolean {
  if (!isHlsUrl(url)) return false
  if (typeof document === 'undefined') return true
  const probe = document.createElement('video')
  return !probe.canPlayType('application/vnd.apple.mpegurl')
}

const ready = ref(false)
const blocked = ref(false)
const visible = ref(false)
const errored = ref(false)
const usingHlsJs = ref(false)
const videoEl = ref<HTMLVideoElement | null>(null)
const videoSrc = computed(() => (usingHlsJs.value ? undefined : props.clipUrl))

let hlsInstance: Hls | null = null
// Flipped in onBeforeUnmount, before destroyHls() runs, so the awaited steps below (both the
// dynamic import and anything after it) can tell a since-unmounted component apart from one still
// on screen. Without this, unmounting while loadHlsConstructor()'s import() is still in flight
// leaves destroyHls() a no-op (hlsInstance is still null at that point), and the import later
// resolving would go on to construct an Hls instance against a detached video element that is
// never destroyed.
let cancelled = false

function destroyHls() {
  hlsInstance?.destroy()
  hlsInstance = null
}

async function loadHlsConstructor(): Promise<typeof Hls> {
  // The light build drops non-essential features (subtitle/audio-track handling, EME) that a
  // muted, looping background trailer never needs. Imported directly, with no try/catch fallback
  // to the full build: a missing subpath export would fail the BUILD, not fall back at runtime, so
  // the fallback could never run — while Rollup emitted the full 574 KB build as a second chunk
  // and the browser fetched both.
  return (await import('hls.js/light')).default
}

async function attachHls(video: HTMLVideoElement) {
  const HlsCtor = await loadHlsConstructor()
  if (cancelled) return
  if (!HlsCtor.isSupported()) {
    errored.value = true
    return
  }
  const hls = new HlsCtor({ capLevelToPlayerSize: true })
  if (cancelled) {
    hls.destroy()
    return
  }
  hlsInstance = hls
  hls.on(HlsCtor.Events.MANIFEST_PARSED, () => {
    // Cap playback at 720p regardless of player size: this is a muted, decorative background
    // video, not something worth spending 1080p bandwidth on. Pick the highest-quality level at
    // or under 720p, not merely the last one under it (levels aren't guaranteed to be sorted).
    const capIndex = hls.levels.reduce((best, level, index) => {
      if (!level.height || level.height > HLS_MAX_LEVEL_HEIGHT) return best
      if (best === -1 || level.height > hls.levels[best]!.height!) return index
      return best
    }, -1)
    if (capIndex >= 0) hls.autoLevelCapping = capIndex
  })
  hls.on(HlsCtor.Events.ERROR, (_event, data) => {
    if (data.fatal) {
      errored.value = true
      destroyHls()
    }
  })
  if (cancelled) {
    destroyHls()
    return
  }
  hls.loadSource(props.clipUrl)
  hls.attachMedia(video)
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia !== undefined
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

type NetworkInformation = { saveData?: boolean; effectiveType?: string }

function connection(): NetworkInformation | undefined {
  if (typeof navigator === 'undefined') return undefined
  return (navigator as Navigator & { connection?: NetworkInformation }).connection
}

function saveDataEnabled(): boolean {
  return connection()?.saveData === true
}

/** The Network Information API is not universal; an absent reading is treated as fast. */
function connectionIsSlow(): boolean {
  const effectiveType = connection()?.effectiveType
  return effectiveType !== undefined && effectiveType !== '4g'
}

/**
 * Matched once, on mount, rather than watched: a visitor who rotates a phone into landscape has
 * already been given the poster, and swapping in a multi-megabyte video mid-scroll would be a
 * worse experience than the one they are having.
 */
function viewportIsWideEnough(): boolean {
  if (typeof window === 'undefined' || window.matchMedia === undefined) return false
  return window.matchMedia(`(min-width: ${MIN_VIDEO_VIEWPORT_PX}px)`).matches
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

// Tracks whichever deferral mechanism actually scheduled the callback, so it can be cancelled on
// unmount — leaving the page before the browser goes idle must not still flip `ready` afterwards
// and start fetching/creating a video element nobody will see.
let idleHandle: number | null = null
let timeoutHandle: ReturnType<typeof setTimeout> | null = null

function scheduleWhenIdle(callback: () => void) {
  const idleWindow = window as IdleWindow
  if (typeof idleWindow.requestIdleCallback === 'function') {
    idleHandle = idleWindow.requestIdleCallback(callback, { timeout: 2000 })
  } else {
    timeoutHandle = setTimeout(callback, 200)
  }
}

function cancelScheduledIdle() {
  const idleWindow = window as IdleWindow
  if (idleHandle !== null) {
    idleWindow.cancelIdleCallback?.(idleHandle)
    idleHandle = null
  }
  if (timeoutHandle !== null) {
    clearTimeout(timeoutHandle)
    timeoutHandle = null
  }
}

onMounted(() => {
  if (
    !props.clipUrl ||
    !viewportIsWideEnough() ||
    connectionIsSlow() ||
    prefersReducedMotion() ||
    saveDataEnabled()
  ) {
    blocked.value = true
    return
  }
  usingHlsJs.value = needsHlsJs(props.clipUrl)
  scheduleWhenIdle(() => {
    ready.value = true
  })
})

watch(ready, async (isReady) => {
  if (!isReady || !usingHlsJs.value) return
  await nextTick()
  if (cancelled) return
  if (videoEl.value) await attachHls(videoEl.value)
})

onBeforeUnmount(() => {
  cancelled = true
  cancelScheduledIdle()
  destroyHls()
})

watch(
  () => props.paused,
  (isPaused) => {
    if (!videoEl.value) return
    if (isPaused) videoEl.value.pause()
    else void videoEl.value.play().catch(() => {})
  },
)

function toggle() {
  emit('update:paused', !props.paused)
}
</script>

<template>
  <template v-if="ready && !blocked && !errored">
    <video
      ref="videoEl"
      muted
      loop
      playsinline
      autoplay
      preload="none"
      :src="videoSrc"
      class="absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-500 ease-out motion-reduce:transition-none"
      :class="visible ? 'opacity-100' : ''"
      @canplay="visible = true"
      @error="errored = true"
    />
    <button
      type="button"
      class="absolute bottom-24 left-4 z-10 inline-flex h-10 w-10 items-center justify-center rounded-chip border border-line bg-surface-1/80 text-fg backdrop-blur focus-visible:outline-2 sm:bottom-6 sm:left-6"
      :aria-pressed="paused"
      :aria-label="paused ? t('home.hero.videoPlay') : t('home.hero.videoPause')"
      @click="toggle"
    >
      <svg
        v-if="paused"
        aria-hidden="true"
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="currentColor"
      >
        <path
          d="M4.5 2.8v10.4a.8.8 0 0 0 1.22.68l8.2-5.2a.8.8 0 0 0 0-1.36l-8.2-5.2a.8.8 0 0 0-1.22.68Z"
        />
      </svg>
      <svg v-else aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
        <rect x="4" y="2.5" width="2.8" height="11" rx="0.6" />
        <rect x="9.2" y="2.5" width="2.8" height="11" rx="0.6" />
      </svg>
    </button>
  </template>
</template>
