<script setup lang="ts">
/**
 * Collapsible section used inside `FilterPanel`. Open/closed state lives in the
 * filters store, keyed by `sectionId`, so it survives while the drawer stays
 * open or is reopened later in the same session. Until the visitor toggles a
 * section explicitly, it falls back to `active` (open when it holds a value).
 */
const props = defineProps<{ sectionId: string; title: string; active?: boolean }>()

const store = useFiltersStore()

const open = computed({
  get: () => store.openSections[props.sectionId] ?? props.active ?? false,
  set: (value: boolean) => {
    store.openSections[props.sectionId] = value
  },
})

const contentId = computed(() => `filter-section-${props.sectionId}`)

function toggle() {
  open.value = !open.value
}
</script>

<template>
  <div class="border-t border-line py-3 first:border-t-0 first:pt-0">
    <button
      type="button"
      class="flex w-full items-center justify-between gap-2 text-left text-sm font-semibold text-fg focus-visible:outline-2"
      :aria-expanded="open"
      :aria-controls="contentId"
      @click="toggle"
    >
      <span>{{ title }}</span>
      <svg
        class="size-4 shrink-0 text-fg-2 transition-transform duration-150 motion-reduce:transition-none"
        :class="{ 'rotate-180': open }"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
    <div v-show="open" :id="contentId" class="mt-3 space-y-3">
      <slot />
    </div>
  </div>
</template>
