<script setup lang="ts">
import type { PlatformFamilyValue } from '#shared/catalog'

const props = withDefaults(defineProps<{ families: PlatformFamilyValue[]; max?: number }>(), {
  max: 5,
})
const { t } = useI18n()

const visible = computed(() => props.families.filter((family) => family !== 'OTHER'))
const shown = computed(() => visible.value.slice(0, props.max))
const hidden = computed(() => visible.value.slice(props.max))
const overflowCount = computed(() => hidden.value.length)

const nameFor = (family: PlatformFamilyValue) => t(`card.platformNames.${family}`)
const hiddenNamesLabel = computed(() => hidden.value.map(nameFor).join(', '))
</script>

<template>
  <ul class="flex items-center gap-x-1 text-xs text-fg-2" :aria-label="t('card.platformsLabel')">
    <li
      v-for="(family, index) in shown"
      :key="`${family}-${index}`"
      class="flex items-center gap-1"
    >
      <span v-if="index > 0" aria-hidden="true">·</span>
      <span>{{ nameFor(family) }}</span>
    </li>
    <li v-if="overflowCount > 0" class="flex items-center gap-1" :title="hiddenNamesLabel">
      <span aria-hidden="true">·</span>
      <i18n-t keypath="card.platformsMore" tag="span" :aria-label="hiddenNamesLabel">
        <template #count
          ><span class="font-numeric">{{ overflowCount }}</span></template
        >
      </i18n-t>
    </li>
  </ul>
</template>
