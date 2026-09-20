<script setup lang="ts">
import type { GameQuery } from '~/graphql/__generated__/operations'
import { GALLERY_LIGHTBOX_IMAGE_SIZES } from '~/utils/rawgImage'

type GalleryImage = NonNullable<GameQuery['game']>['screenshots'][number]

const props = defineProps<{ images: GalleryImage[]; title: string; initialIndex: number }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

// Above this count, dots (each a 24px hit area with 4px between them) no longer fit a 360px
// phone alongside the dialog's own padding (11 * 24px + 10 * 4px = 304px, the most that fits
// inside a 360px viewport minus the dialog's p-4; 12 would need 332px), so the counter falls
// back to compact "n / total" text instead.
const MAX_DOTS = 11

const current = ref(props.initialIndex)
const imageLoaded = ref(false)
const dialogRef = ref<HTMLElement | null>(null)
const closeButtonRef = ref<HTMLButtonElement | null>(null)

const total = computed(() => props.images.length)
const activeImage = computed(() => props.images[current.value]!)
const activeAlt = computed(() =>
  t('gallery.thumbnailAlt', { title: props.title, n: current.value + 1 }),
)
const showDots = computed(() => total.value > 1 && total.value <= MAX_DOTS)
const showFallbackCounter = computed(() => total.value > MAX_DOTS)

watch(current, () => {
  imageLoaded.value = false
})

function goTo(index: number) {
  current.value = index
}
function next() {
  current.value = (current.value + 1) % total.value
}
function prev() {
  current.value = (current.value - 1 + total.value) % total.value
}
function close() {
  emit('close')
}

// Queried once per open rather than on every Tab: the dialog's focusable set is fixed for the
// lifetime of the lightbox (a close button and, when there is more than one screenshot, the two
// arrows), so re-reading the DOM on each keystroke only costs.
let focusable: HTMLElement[] | null = null

function focusableElements(): HTMLElement[] {
  if (focusable) return focusable
  if (!dialogRef.value) return []
  focusable = Array.from(
    dialogRef.value.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  )
  return focusable
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (total.value > 1 && event.key === 'ArrowRight') {
    event.preventDefault()
    next()
    return
  }
  if (total.value > 1 && event.key === 'ArrowLeft') {
    event.preventDefault()
    prev()
    return
  }
  if (event.key === 'Tab') {
    const elements = focusableElements()
    if (!elements.length) return
    const first = elements[0]!
    const last = elements[elements.length - 1]!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
}

let previousOverflow = ''

onMounted(() => {
  previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  closeButtonRef.value?.focus()
})

onBeforeUnmount(() => {
  document.body.style.overflow = previousOverflow
})
</script>

<template>
  <div
    ref="dialogRef"
    role="dialog"
    aria-modal="true"
    :aria-label="t('gallery.dialogLabel', { title })"
    class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-ink/95 p-4"
    @keydown="onKeydown"
  >
    <span class="sr-only" aria-live="polite">
      {{ t('gallery.counterAnnouncement', { current: current + 1, total }) }}
    </span>

    <button
      ref="closeButtonRef"
      type="button"
      class="absolute right-4 top-4 z-10 flex h-11 w-11 items-center justify-center rounded-chip border border-line bg-surface-1 text-fg transition-colors duration-200 ease-out hover:border-fg-2 focus-visible:outline-2"
      @click="close"
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
        <path
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          d="M3 3l10 10M13 3L3 13"
        />
      </svg>
      <span class="sr-only">{{ t('gallery.close') }}</span>
    </button>

    <div class="relative flex w-full max-w-4xl flex-1 items-center justify-center">
      <button
        v-if="total > 1"
        type="button"
        class="absolute left-2 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-chip border border-line bg-surface-1 text-fg transition-colors duration-200 ease-out hover:border-fg-2 focus-visible:outline-2 sm:left-0 sm:-translate-x-[calc(100%+1rem)]"
        :aria-label="t('gallery.previous')"
        @click="prev"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
          <path
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            fill="none"
            d="M10 2.5L4.5 8l5.5 5.5"
          />
        </svg>
      </button>

      <div
        class="relative flex aspect-video max-h-[60vh] w-full items-center justify-center overflow-hidden rounded-card"
      >
        <NuxtImg
          :key="current"
          :src="activeImage.url"
          :alt="activeAlt"
          width="1280"
          height="720"
          :sizes="GALLERY_LIGHTBOX_IMAGE_SIZES"
          class="h-full w-full object-contain opacity-0 transition-opacity duration-200 ease-out"
          :class="{ 'opacity-100': imageLoaded }"
          @load="imageLoaded = true"
        />
      </div>

      <button
        v-if="total > 1"
        type="button"
        class="absolute right-2 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-chip border border-line bg-surface-1 text-fg transition-colors duration-200 ease-out hover:border-fg-2 focus-visible:outline-2 sm:right-0 sm:translate-x-[calc(100%+1rem)]"
        :aria-label="t('gallery.next')"
        @click="next"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
          <path
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            fill="none"
            d="M6 2.5L11.5 8L6 13.5"
          />
        </svg>
      </button>
    </div>

    <div v-if="showDots" class="mt-3 flex items-center justify-center gap-1">
      <button
        v-for="(image, index) in images"
        :key="image.url"
        type="button"
        class="group flex h-6 w-6 items-center justify-center focus-visible:outline-2"
        :aria-label="t('gallery.dotLabel', { n: index + 1, total })"
        :aria-current="index === current ? 'true' : undefined"
        @click="goTo(index)"
      >
        <span
          aria-hidden="true"
          class="rounded-full transition-colors duration-200 ease-out"
          :class="
            index === current ? 'h-2.5 w-2.5 bg-accent' : 'h-2 w-2 bg-fg-3 group-hover:bg-fg-2'
          "
        />
      </button>
    </div>
    <span v-else-if="showFallbackCounter" class="font-numeric mt-3 text-sm text-fg-2">
      {{ t('gallery.counter', { current: current + 1, total }) }}
    </span>
  </div>
</template>
