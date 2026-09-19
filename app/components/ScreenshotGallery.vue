<script setup lang="ts">
import type { GameQuery } from '~/graphql/__generated__/operations'

type GalleryImage = NonNullable<GameQuery['game']>['screenshots'][number]

const props = defineProps<{ images: GalleryImage[]; title: string }>()
const { t } = useI18n()

// The lightbox (focus trap, keyboard navigation, body-scroll lock) is only needed once a
// visitor opens a screenshot, so it ships as its own chunk instead of weighing on first load.
// Thumbnails above still render on the server.
const ScreenshotGalleryLightbox = defineAsyncComponent(
  () => import('./ScreenshotGalleryLightbox.vue'),
)

const openIndex = ref<number | null>(null)
const thumbnailRefs = ref<(HTMLButtonElement | null)[]>([])

function setThumbnailRef(el: Element | null, index: number) {
  thumbnailRefs.value[index] = el as HTMLButtonElement | null
}

function open(index: number) {
  openIndex.value = index
}

function close() {
  const index = openIndex.value
  openIndex.value = null
  if (index === null) return
  nextTick(() => thumbnailRefs.value[index]?.focus())
}

function altFor(index: number) {
  return t('gallery.thumbnailAlt', { title: props.title, n: index + 1 })
}
</script>

<template>
  <section v-if="images.length" aria-labelledby="screenshot-gallery-heading">
    <h2 id="screenshot-gallery-heading" class="font-display-heading text-xl text-fg">
      {{ t('gallery.heading') }}
    </h2>
    <ul class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
      <li v-for="(image, index) in images" :key="image.url">
        <button
          :ref="(el) => setThumbnailRef(el as Element | null, index)"
          type="button"
          class="group block w-full overflow-hidden rounded-card border border-line focus-visible:outline-2"
          @click="open(index)"
          @keydown.enter.prevent="open(index)"
          @keydown.space.prevent="open(index)"
        >
          <NuxtImg
            :src="image.url"
            :alt="altFor(index)"
            width="480"
            height="270"
            loading="lazy"
            sizes="(max-width: 640px) 50vw, 33vw"
            class="aspect-video w-full object-cover transition-transform duration-200 ease-out group-hover:scale-[1.03] group-focus-visible:scale-[1.03]"
          />
        </button>
      </li>
    </ul>

    <ScreenshotGalleryLightbox
      v-if="openIndex !== null"
      :images="images"
      :title="title"
      :initial-index="openIndex"
      @close="close"
    />
  </section>
</template>
