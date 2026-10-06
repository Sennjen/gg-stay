<script setup lang="ts">
/**
 * What the visitor sees while an answer is on its way: Gege thinking, a line beside him that
 * changes as the seconds pass, and the outline of the rows to come.
 *
 * The lines follow a clock, not the request: nothing here knows which step the endpoint is on, and
 * the answer may land during any of them. They are there so a wait of several seconds does not
 * look like a page that stopped.
 *
 * The changing line is deliberately not a live region. The page's own status region announces the
 * wait once; a region that spoke again every two seconds would talk over the answer.
 */

/** When each line takes over, in milliseconds since the wait began. */
const STAGES = [
  { key: 'reading', at: 0 },
  { key: 'searching', at: 2000 },
  { key: 'explaining', at: 4000 },
] as const

const { t } = useI18n()

const stage = ref(0)
const timers: ReturnType<typeof setTimeout>[] = []

onMounted(() => {
  STAGES.forEach(({ at }, index) => {
    if (at > 0) timers.push(setTimeout(() => (stage.value = index), at))
  })
})

onBeforeUnmount(() => {
  for (const timer of timers.splice(0)) clearTimeout(timer)
})
</script>

<template>
  <div data-test="ask-loading">
    <GegeSpeech mood="thinking">
      <p data-test="ask-waiting-line" class="px-4 py-3 text-fg">
        {{ t(`ask.waiting.${STAGES[stage]!.key}`) }}
      </p>
    </GegeSpeech>
    <ul aria-hidden="true" class="mt-6 space-y-3">
      <li
        v-for="index in 3"
        :key="index"
        data-test="skeleton"
        class="flex gap-4 rounded-card border border-line bg-surface-1 p-3"
      >
        <div
          class="aspect-video w-28 shrink-0 rounded-lg bg-surface-2 motion-safe:animate-pulse sm:w-40"
        />
        <div class="min-w-0 flex-1 space-y-2 py-1">
          <div class="h-4 w-1/2 rounded bg-surface-2 motion-safe:animate-pulse" />
          <div class="h-4 w-4/5 rounded bg-surface-2 motion-safe:animate-pulse" />
          <div class="h-3 w-1/3 rounded bg-surface-2 motion-safe:animate-pulse" />
        </div>
      </li>
    </ul>
  </div>
</template>
