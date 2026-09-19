<script setup lang="ts">
const props = withDefaults(defineProps<{ score: number; caption?: boolean }>(), {
  caption: false,
})
const { t } = useI18n()

const band = computed<'good' | 'mixed' | 'bad'>(() => {
  if (props.score >= 75) return 'good'
  if (props.score >= 50) return 'mixed'
  return 'bad'
})

const bandClasses = {
  good: 'bg-score-good-bg text-score-good',
  mixed: 'bg-score-mixed-bg text-score-mixed',
  bad: 'bg-score-bad-bg text-score-bad',
} as const
</script>

<template>
  <span v-if="caption" class="inline-flex items-center gap-1.5">
    <span class="text-xs text-fg-2">
      <span class="hidden min-[360px]:inline">{{ t('card.metacriticCaption') }}</span>
      <!-- Below ~360px (a 2-column grid's card width) "Metacritic" no longer fits next to the
           chip on one line; fall back to the short form, keeping the full word as a tooltip. -->
      <span class="min-[360px]:hidden" :title="t('card.metacriticCaption')">{{
        t('card.metacriticCaptionShort')
      }}</span>
    </span>
    <span
      role="img"
      :data-band="band"
      :aria-label="t('card.metacriticLabel', { score })"
      class="font-numeric inline-flex items-center justify-center rounded-chip px-1.5 py-0.5 text-xs font-semibold"
      :class="bandClasses[band]"
    >
      {{ score }}
    </span>
  </span>
  <span
    v-else
    role="img"
    :data-band="band"
    :aria-label="t('card.metacriticLabel', { score })"
    class="font-numeric inline-flex items-center justify-center rounded-chip px-1.5 py-0.5 text-xs font-semibold"
    :class="bandClasses[band]"
  >
    {{ score }}
  </span>
</template>
