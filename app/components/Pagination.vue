<script setup lang="ts">
import { buildPageList } from '~/utils/buildPageList'

/**
 * Numbered pagination as real `<a href>`s built from the current query, so it
 * works without JS and is crawlable. `totalPages` is computed by the page
 * (`ceil(total / pageSize)`, capped at `MAX_PAGE`). A click still emits
 * `change` for client-side navigation, matching `useGameFilters`'s one
 * `router.push` per change.
 */
const props = defineProps<{ page: number; totalPages: number }>()
const emit = defineEmits<{ change: [page: number] }>()
const { t } = useI18n()
const route = useRoute()
const router = useRouter()

function hrefFor(page: number): string {
  const query: Record<string, string> = {}
  for (const [key, value] of Object.entries(route.query)) {
    if (key === 'page' || typeof value !== 'string') continue
    query[key] = value
  }
  if (page > 1) query.page = String(page)
  return router.resolve({ path: route.path, query }).href
}

function go(page: number, event: MouseEvent) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return
  event.preventDefault()
  emit('change', page)
}

const pages = computed(() => buildPageList(props.page, props.totalPages))
</script>

<template>
  <nav
    class="mt-8 flex items-center justify-center gap-1"
    :aria-label="t('catalog.page', { page })"
  >
    <a
      :href="hrefFor(Math.max(page - 1, 1))"
      class="rounded-chip border border-line bg-surface-1 px-3 py-2 text-sm text-fg focus-visible:outline-2 aria-disabled:pointer-events-none aria-disabled:opacity-40"
      :aria-disabled="page <= 1"
      :tabindex="page <= 1 ? -1 : undefined"
      @click="page > 1 && go(page - 1, $event)"
    >
      {{ t('catalog.prev') }}
    </a>

    <template v-for="(entry, index) in pages" :key="index">
      <span v-if="entry === 'ellipsis'" class="px-2 text-sm text-fg-2" aria-hidden="true">…</span>
      <a
        v-else
        :href="hrefFor(entry)"
        class="font-numeric rounded-chip px-3 py-2 text-sm focus-visible:outline-2"
        :class="
          entry === page
            ? 'bg-accent text-on-accent'
            : 'border border-line bg-surface-1 text-fg hover:text-fg'
        "
        :aria-current="entry === page ? 'page' : undefined"
        @click="go(entry, $event)"
      >
        {{ entry }}
      </a>
    </template>

    <a
      :href="hrefFor(Math.min(page + 1, totalPages))"
      class="rounded-chip border border-line bg-surface-1 px-3 py-2 text-sm text-fg focus-visible:outline-2 aria-disabled:pointer-events-none aria-disabled:opacity-40"
      :aria-disabled="page >= totalPages"
      :tabindex="page >= totalPages ? -1 : undefined"
      @click="page < totalPages && go(page + 1, $event)"
    >
      {{ t('catalog.next') }}
    </a>
  </nav>
</template>
