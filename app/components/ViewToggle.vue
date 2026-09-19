<script setup lang="ts">
/**
 * Grid/list preference, stored in the filters Pinia store (not the URL). The
 * store defaults to "grid" for both the server render and the first client
 * render, so hydration always matches; the persisted `localStorage` value is
 * applied only after mount.
 */
const STORAGE_KEY = 'gg-stay:view-mode'

const store = useFiltersStore()
const { t } = useI18n()

onMounted(() => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'grid' || stored === 'list') store.viewMode = stored
  } catch {
    // Storage may be unavailable (private mode, blocked); grid stays the default.
  }
})

watch(
  () => store.viewMode,
  (value) => {
    try {
      localStorage.setItem(STORAGE_KEY, value)
    } catch {
      // Ignore write failures; the preference just won't persist this session.
    }
  },
)
</script>

<template>
  <div
    role="group"
    :aria-label="t('catalog.view')"
    class="inline-flex rounded-chip border border-line bg-surface-1 p-1"
  >
    <button
      type="button"
      class="flex size-8 items-center justify-center rounded-chip focus-visible:outline-2"
      :class="store.viewMode === 'grid' ? 'bg-accent text-on-accent' : 'text-fg-2 hover:text-fg'"
      :aria-pressed="store.viewMode === 'grid'"
      :aria-label="t('catalog.viewGrid')"
      @click="store.viewMode = 'grid'"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    </button>
    <button
      type="button"
      class="flex size-8 items-center justify-center rounded-chip focus-visible:outline-2"
      :class="store.viewMode === 'list' ? 'bg-accent text-on-accent' : 'text-fg-2 hover:text-fg'"
      :aria-pressed="store.viewMode === 'list'"
      :aria-label="t('catalog.viewList')"
      @click="store.viewMode = 'list'"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <line x1="4" y1="6" x2="20" y2="6" />
        <line x1="4" y1="12" x2="20" y2="12" />
        <line x1="4" y1="18" x2="20" y2="18" />
      </svg>
    </button>
  </div>
</template>
