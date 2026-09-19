<script setup lang="ts">
// Adds <html lang>, hreflang alternates and the canonical link for the current locale.
const head = useLocaleHead({ seo: true })
useHead({
  htmlAttrs: { lang: () => head.value.htmlAttrs?.lang },
  // An SVG favicon, self-hosted (and therefore allowed by `img-src 'self'`), so the tab does not
  // show the browser's default globe. One file, no raster sizes: every browser this app supports
  // reads SVG favicons, and the mark is two shapes.
  link: () => [
    { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
    ...(head.value.link ?? []),
  ],
  meta: () => head.value.meta ?? [],
})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
