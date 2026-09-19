<script setup lang="ts">
// Rendered only inside a <ClientOnly> wrapper, and only after the page goes idle, so this
// component never competes with the hero poster (the LCP element) for bandwidth. It also
// self-guards against `prefers-reduced-motion` and Save-Data, in case a caller mounts it
// directly without pre-checking those (see the parent's own `v-if="clipUrl"` guard).
const props = defineProps<{ clipUrl: string; paused: boolean }>()
const emit = defineEmits<{ 'update:paused': [value: boolean] }>()
const { t } = useI18n()

const ready = ref(false)
const blocked = ref(false)
const visible = ref(false)
const errored = ref(false)
const videoEl = ref<HTMLVideoElement | null>(null)

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia !== undefined
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

function saveDataEnabled(): boolean {
  if (typeof navigator === 'undefined') return false
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  return connection?.saveData === true
}

function scheduleWhenIdle(callback: () => void) {
  const nuxtWindow = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  }
  if (typeof nuxtWindow.requestIdleCallback === 'function') {
    nuxtWindow.requestIdleCallback(callback, { timeout: 2000 })
  } else {
    setTimeout(callback, 200)
  }
}

onMounted(() => {
  if (!props.clipUrl || prefersReducedMotion() || saveDataEnabled()) {
    blocked.value = true
    return
  }
  scheduleWhenIdle(() => {
    ready.value = true
  })
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
      :src="clipUrl"
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
