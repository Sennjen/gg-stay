<script setup lang="ts">
export interface LocalisationBadgeInfo {
  text: boolean
  audio: boolean
}

const props = defineProps<{ localisation: LocalisationBadgeInfo | null }>()
const { t } = useI18n()

const visible = computed(
  () => !!props.localisation && (props.localisation.text || props.localisation.audio),
)
const accessibleLabel = computed(() =>
  props.localisation?.audio ? t('localisation.audio') : t('localisation.text'),
)

// `role="img"`: the same pattern `MetacriticBadge` uses — the element becomes a single unit with
// one accessible name (`aria-label`), so a screen reader announces the whole thing once instead
// of "UA" and the speaker glyph as separate fragments. `title` repeats the same text so a sighted
// mouse user gets a tooltip without needing the visible short form explained.
// (Kept as a script comment, not a template one: a template comment ahead of a single `v-if` root
// compiles to a two-node fragment — [comment, span] — which breaks single-root assumptions like
// `wrapper.element` in tests, so the component would no longer act like a single element.)
</script>

<template>
  <span
    v-if="visible"
    data-test="localisation"
    role="img"
    :aria-label="accessibleLabel"
    :title="accessibleLabel"
    class="inline-flex shrink-0 items-center gap-1 rounded-chip border border-line px-1.5 py-0.5 text-xs font-semibold text-fg-2"
  >
    UA
    <svg
      v-if="localisation?.audio"
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="currentColor"
    >
      <path
        d="M2 6h2.5l3.3-2.9c.4-.3 1-.1 1 .5v8.8c0 .6-.6.9-1 .5L4.5 10H2a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z"
      />
      <path
        d="M11 5.2a3.2 3.2 0 0 1 0 5.6"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
      />
    </svg>
  </span>
</template>
