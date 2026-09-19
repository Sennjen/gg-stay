<script setup lang="ts">
import type { PlatformFamilyValue } from '#shared/catalog'

const props = defineProps<{ families: PlatformFamilyValue[] }>()
const { t } = useI18n()

const MAX_ICONS = 5

const visible = computed(() => props.families.filter((family) => family !== 'OTHER'))
const shown = computed(() => visible.value.slice(0, MAX_ICONS))
const overflowCount = computed(() => Math.max(0, visible.value.length - MAX_ICONS))

const nameFor = (family: PlatformFamilyValue) => t(`card.platformNames.${family}`)
</script>

<template>
  <ul class="flex items-center gap-1.5 text-fg-2" :aria-label="t('card.platformsLabel')">
    <li v-for="(family, index) in shown" :key="`${family}-${index}`">
      <span class="sr-only">{{ nameFor(family) }}</span>
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <template v-if="family === 'PC'">
          <rect x="1.5" y="2.5" width="13" height="8.5" rx="1" />
          <path d="M6 13.5h4M8 11v2.5" />
        </template>
        <template v-else-if="family === 'PLAYSTATION'">
          <rect x="1.5" y="5" width="13" height="7" rx="3" />
          <circle cx="5" cy="8.5" r="0.6" fill="currentColor" stroke="none" />
          <circle cx="11" cy="7.3" r="0.6" fill="currentColor" stroke="none" />
          <circle cx="11" cy="9.7" r="0.6" fill="currentColor" stroke="none" />
        </template>
        <template v-else-if="family === 'XBOX'">
          <rect x="1.5" y="5" width="13" height="7" rx="3" />
          <path d="M4 7v3M2.5 8.5h3" />
          <circle cx="11.5" cy="8.5" r="0.9" fill="currentColor" stroke="none" />
        </template>
        <template v-else-if="family === 'NINTENDO'">
          <rect x="1.5" y="3.5" width="4" height="9" rx="2" />
          <rect x="10.5" y="3.5" width="4" height="9" rx="2" />
          <path d="M5.5 8h5" />
        </template>
        <template v-else-if="family === 'MOBILE'">
          <rect x="4.5" y="1.5" width="7" height="13" rx="1.3" />
          <circle cx="8" cy="12.3" r="0.5" fill="currentColor" stroke="none" />
        </template>
      </svg>
    </li>
    <i18n-t
      v-if="overflowCount > 0"
      keypath="card.platformsMore"
      tag="li"
      class="text-xs text-fg-2"
    >
      <template #count
        ><span class="font-numeric">{{ overflowCount }}</span></template
      >
    </i18n-t>
  </ul>
</template>
