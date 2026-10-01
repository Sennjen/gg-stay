<script setup lang="ts">
import { SITE_NAME } from '~/utils/seo'

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
// What every page's preview card shares; each page adds its own title, description and image.
useSeoMeta({
  ogSiteName: SITE_NAME,
  ogType: 'website',
  twitterCard: 'summary_large_image',
})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
