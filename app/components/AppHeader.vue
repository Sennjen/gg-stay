<script setup lang="ts">
const route = useRoute()
const { t } = useI18n()
const localePath = useLocalePath()

// Transparent only over the hero on the landing page, and only before the
// visitor scrolls past it. SSR has no scroll position, so it renders the
// solid bar for every non-landing route and the transparent one for the
// landing route — `scrolled` starts `false` on both server and client, so
// hydration always matches; `onMounted` then reads the real position.
const isLandingRoute = computed(() => route.path === localePath('/'))
const scrolled = ref(false)

function updateScrolled() {
  scrolled.value = window.scrollY > 0
}

onMounted(() => {
  updateScrolled()
  window.addEventListener('scroll', updateScrolled, { passive: true })
})
onBeforeUnmount(() => window.removeEventListener('scroll', updateScrolled))

const isTransparent = computed(() => isLandingRoute.value && !scrolled.value)
</script>

<template>
  <header
    class="sticky top-0 z-40 border-b transition-colors duration-200 motion-reduce:transition-none"
    :class="
      isTransparent
        ? 'border-transparent bg-transparent'
        : 'border-line bg-surface-1/80 backdrop-blur'
    "
  >
    <div class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
      <NuxtLink
        :to="localePath('/')"
        class="font-display-heading text-xl text-fg focus-visible:outline-2"
      >
        GG Stay
      </NuxtLink>

      <div class="flex flex-1 items-center justify-end gap-4">
        <NuxtLink
          :to="localePath('/games')"
          class="text-sm text-fg underline-offset-4 hover:underline focus-visible:outline-2"
        >
          {{ t('nav.catalog') }}
        </NuxtLink>
        <HeaderSearch class="max-w-[360px] flex-none" />
        <LocaleSwitcher />
      </div>
    </div>
  </header>
</template>
