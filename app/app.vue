<script setup lang="ts">
// Adds <html lang>, hreflang alternates and the canonical link for the current locale.
const head = useLocaleHead({ seo: true })
useHead({
  htmlAttrs: { lang: () => head.value.htmlAttrs?.lang },
  link: () => head.value.link ?? [],
  meta: () => head.value.meta ?? [],
})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
