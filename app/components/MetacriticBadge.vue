<script setup lang="ts">
const props = defineProps<{ score: number }>()
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
  <span
    role="img"
    :data-band="band"
    :aria-label="t('card.metacriticLabel', { score })"
    class="font-numeric inline-flex items-center justify-center rounded-chip px-1.5 py-0.5 text-xs font-semibold"
    :class="bandClasses[band]"
  >
    {{ score }}
  </span>
</template>
