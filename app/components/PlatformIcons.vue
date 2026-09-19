<script setup lang="ts">
import type { PlatformFamilyValue } from '#shared/catalog'

// `responsive`, when set, renders three fixed truncation levels (1/2/3 labels) as separate
// `<ul>`s, each shown only at its own container-query width (see GameCard's usage) so a narrow
// card degrades by whole labels instead of one `max` value clipping mid-letter. Without
// `responsive`, behaviour is unchanged: a single list capped at `max` (used by the game page
// scoreboard, which just wraps). The three `<ul>`s are written out literally rather than looped
// over an array — a `v-for` of `<ul>`s nested inside the `responsive` conditional produced a
// server/client hydration node-count mismatch on the landing page's game rows.
defineOptions({ inheritAttrs: false })
const props = withDefaults(
  defineProps<{ families: PlatformFamilyValue[]; max?: number; responsive?: boolean }>(),
  { max: 5, responsive: false },
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
</script>

<template>
  <!-- Always exactly one root: `display: contents` so it never affects layout, and the v-if/v-else
       for the two rendering modes lives inside this stable root rather than toggling the root
       itself. -->
  <div class="contents">
    <template v-if="responsive">
      <span class="sr-only">{{ t('card.platformsLabel') }}: {{ fullNamesLabel }}</span>
      <!-- < 200px: 1 label + N -->
      <ul
        aria-hidden="true"
        class="@min-[200px]:hidden flex items-center gap-x-1 text-xs text-fg-2"
      >
        <li
          v-for="(family, familyIndex) in shownFor(1)"
          :key="`${family}-${familyIndex}`"
          class="flex shrink-0 items-center gap-1 whitespace-nowrap"
        >
          <span v-if="familyIndex > 0" aria-hidden="true">·</span>
          <span>{{ nameFor(family) }}</span>
        </li>
        <li
          v-if="overflowCountFor(1) > 0"
          class="flex shrink-0 items-center gap-1 whitespace-nowrap"
          :title="hiddenNamesLabelFor(1)"
        >
          <span aria-hidden="true">·</span>
          <i18n-t keypath="card.platformsMore" tag="span">
            <template #count
              ><span class="font-numeric">{{ overflowCountFor(1) }}</span></template
            >
          </i18n-t>
        </li>
      </ul>
      <!-- 200–279px: 2 labels + N -->
      <ul
        aria-hidden="true"
        class="hidden @min-[200px]:flex @min-[280px]:hidden items-center gap-x-1 text-xs text-fg-2"
      >
        <li
          v-for="(family, familyIndex) in shownFor(2)"
          :key="`${family}-${familyIndex}`"
          class="flex shrink-0 items-center gap-1 whitespace-nowrap"
        >
          <span v-if="familyIndex > 0" aria-hidden="true">·</span>
          <span>{{ nameFor(family) }}</span>
        </li>
        <li
          v-if="overflowCountFor(2) > 0"
          class="flex shrink-0 items-center gap-1 whitespace-nowrap"
          :title="hiddenNamesLabelFor(2)"
        >
          <span aria-hidden="true">·</span>
          <i18n-t keypath="card.platformsMore" tag="span">
            <template #count
              ><span class="font-numeric">{{ overflowCountFor(2) }}</span></template
            >
          </i18n-t>
        </li>
      </ul>
      <!-- >= 280px: 3 labels + N -->
      <ul
        aria-hidden="true"
        class="hidden @min-[280px]:flex items-center gap-x-1 text-xs text-fg-2"
      >
        <li
          v-for="(family, familyIndex) in shownFor(3)"
          :key="`${family}-${familyIndex}`"
          class="flex shrink-0 items-center gap-1 whitespace-nowrap"
        >
          <span v-if="familyIndex > 0" aria-hidden="true">·</span>
          <span>{{ nameFor(family) }}</span>
        </li>
        <li
          v-if="overflowCountFor(3) > 0"
          class="flex shrink-0 items-center gap-1 whitespace-nowrap"
          :title="hiddenNamesLabelFor(3)"
        >
          <span aria-hidden="true">·</span>
          <i18n-t keypath="card.platformsMore" tag="span">
            <template #count
              ><span class="font-numeric">{{ overflowCountFor(3) }}</span></template
            >
          </i18n-t>
        </li>
      </ul>
    </template>
    <ul
      v-else
      v-bind="$attrs"
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
  </div>
</template>
