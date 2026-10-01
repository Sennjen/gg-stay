<script setup lang="ts">
/**
 * `label` names the navigation landmark. The switcher sits in both the header and the footer, and
 * two navigation landmarks with the same name cannot be told apart in a landmark list, so the
 * footer passes its own.
 */
const props = defineProps<{ label?: string }>()
const { locale, locales, t } = useI18n()
const switchLocalePath = useSwitchLocalePath()
const others = computed(() => locales.value.filter((entry) => entry.code !== locale.value))
</script>

<template>
  <nav :aria-label="props.label ?? t('nav.language')">
    <NuxtLink
      v-for="entry in others"
      :key="entry.code"
      :to="switchLocalePath(entry.code)"
      :hreflang="entry.language"
      :lang="entry.code"
      class="rounded px-2 py-1 text-sm text-fg underline-offset-4 hover:underline focus-visible:outline-2"
    >
      {{ entry.name }}
    </NuxtLink>
  </nav>
</template>
