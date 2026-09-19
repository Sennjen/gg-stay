<script setup lang="ts">
import type { PlatformFamilyValue } from '#shared/catalog'

// `variants`, when set, renders one truncation level per entry as a separate `<ul>`, each shown
// only at its own container-query width (see GameCard's usage) so a narrow card degrades by whole
// labels instead of one `max` value clipping mid-letter. Without `variants`, behaviour is
// unchanged: a single list capped at `max` (used by the game page scoreboard, which just wraps).
const props = withDefaults(
  defineProps<{ families: PlatformFamilyValue[]; max?: number; variants?: number[] }>(),
  { max: 5, variants: () => [] },
)
const { t } = useI18n()

const visible = computed(() => props.families.filter((family) => family !== 'OTHER'))
const nameFor = (family: PlatformFamilyValue) => t(`card.platformNames.${family}`)
const fullNamesLabel = computed(() => visible.value.map(nameFor).join(', '))

function shownFor(cap: number) {
  return visible.value.slice(0, cap)
}
function overflowCountFor(cap: number) {
  return Math.max(0, visible.value.length - cap)
}
function hiddenNamesLabelFor(cap: number) {
  return visible.value.slice(cap).map(nameFor).join(', ')
}

// Container-query breakpoints tied to the card meta block's available inline size (see
// DESIGN.md "Card meta row"): < 200px shows 1 label, 200–279px shows 2, >= 280px shows 3.
// Each variant is hidden outside its own range so exactly one is visible at a time.
const VARIANT_CLASSES = [
  '@min-[200px]:hidden',
  'hidden @min-[200px]:flex @min-[280px]:hidden',
  'hidden @min-[280px]:flex',
] as const
</script>

<template>
  <template v-if="variants.length">
    <span class="sr-only">{{ t('card.platformsLabel') }}: {{ fullNamesLabel }}</span>
    <ul
      v-for="(cap, index) in variants"
      :key="cap"
      aria-hidden="true"
      class="flex items-center gap-x-1 text-xs text-fg-2"
      :class="VARIANT_CLASSES[index] ?? ''"
    >
      <li
        v-for="(family, familyIndex) in shownFor(cap)"
        :key="`${family}-${familyIndex}`"
        class="flex shrink-0 items-center gap-1 whitespace-nowrap"
      >
        <span v-if="familyIndex > 0" aria-hidden="true">·</span>
        <span>{{ nameFor(family) }}</span>
      </li>
      <li
        v-if="overflowCountFor(cap) > 0"
        class="flex shrink-0 items-center gap-1 whitespace-nowrap"
        :title="hiddenNamesLabelFor(cap)"
      >
        <span aria-hidden="true">·</span>
        <i18n-t keypath="card.platformsMore" tag="span">
          <template #count
            ><span class="font-numeric">{{ overflowCountFor(cap) }}</span></template
          >
        </i18n-t>
      </li>
    </ul>
  </template>
  <ul
    v-else
    class="flex items-center gap-x-1 text-xs text-fg-2"
    :aria-label="t('card.platformsLabel')"
  >
    <li
      v-for="(family, index) in shownFor(max)"
      :key="`${family}-${index}`"
      class="flex shrink-0 items-center gap-1 whitespace-nowrap"
    >
      <span v-if="index > 0" aria-hidden="true">·</span>
      <span>{{ nameFor(family) }}</span>
    </li>
    <li
      v-if="overflowCountFor(max) > 0"
      class="flex shrink-0 items-center gap-1 whitespace-nowrap"
      :title="hiddenNamesLabelFor(max)"
    >
      <span aria-hidden="true">·</span>
      <i18n-t keypath="card.platformsMore" tag="span" :aria-label="hiddenNamesLabelFor(max)">
        <template #count
          ><span class="font-numeric">{{ overflowCountFor(max) }}</span></template
        >
      </i18n-t>
    </li>
  </ul>
</template>
