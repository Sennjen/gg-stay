<script setup lang="ts">
import type { GameQuery } from '~/graphql/__generated__/operations'

type GalleryImage = NonNullable<GameQuery['game']>['screenshots'][number]

const props = defineProps<{ images: GalleryImage[]; title: string; initialIndex: number }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const current = ref(props.initialIndex)
const dialogRef = ref<HTMLElement | null>(null)
const closeButtonRef = ref<HTMLButtonElement | null>(null)

const total = computed(() => props.images.length)
const activeImage = computed(() => props.images[current.value]!)
const activeAlt = computed(() =>
  t('gallery.thumbnailAlt', { title: props.title, n: current.value + 1 }),
)

function next() {
  current.value = (current.value + 1) % total.value
}
function prev() {
  current.value = (current.value - 1 + total.value) % total.value
}
function close() {
  emit('close')
}

function focusableElements(): HTMLElement[] {
  if (!dialogRef.value) return []
  return Array.from(
    dialogRef.value.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  )
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
    class="fixed inset-0 z-50 flex flex-col bg-ink/90 p-4"
    @keydown="onKeydown"
  >
    <div class="mx-auto flex w-full max-w-4xl items-center justify-between text-sm">
      <span class="font-numeric text-fg-2" aria-live="polite">
        {{ t('gallery.counter', { current: current + 1, total }) }}
      </span>
      <button
        ref="closeButtonRef"
        type="button"
        class="rounded-chip border border-line bg-surface-1 px-3 py-1.5 text-fg transition-colors duration-200 ease-out hover:bg-surface-2 focus-visible:outline-2"
        @click="close"
      >
        {{ t('gallery.close') }}
      </button>
    </div>

    <div class="relative mx-auto flex w-full max-w-4xl flex-1 items-center justify-center">
      <button
        v-if="total > 1"
        type="button"
        class="absolute left-0 rounded-chip border border-line bg-surface-1 p-2 text-fg transition-colors duration-200 ease-out hover:bg-surface-2 focus-visible:outline-2"
        :aria-label="t('gallery.previous')"
        @click="prev"
      >
        ‹
      </button>

      <NuxtImg
        :src="activeImage.url"
        :alt="activeAlt"
        width="1280"
        height="720"
        class="max-h-[70vh] w-full rounded-card object-contain transition-opacity duration-200 ease-out"
      />

      <button
        v-if="total > 1"
        type="button"
        class="absolute right-0 rounded-chip border border-line bg-surface-1 p-2 text-fg transition-colors duration-200 ease-out hover:bg-surface-2 focus-visible:outline-2"
        :aria-label="t('gallery.next')"
        @click="next"
      >
        ›
      </button>
    </div>
  </div>
</template>
