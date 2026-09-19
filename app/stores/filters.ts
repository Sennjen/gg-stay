import { defineStore } from 'pinia'

/** In-memory companion of the URL state: survives navigation, never persisted. */
export const useFiltersStore = defineStore('filters', {
  state: () => ({
    /** Last catalog query, so the detail page can link back to the same filtered list. */
    lastCatalogQuery: {} as Record<string, string>,
    /** Filter drawer open state (mobile and desktop). */
    panelOpen: false,
    /** Which `FilterSection`s are expanded, keyed by section id; remembered for the session. */
    openSections: {} as Record<string, boolean>,
    /** Catalog list layout. Defaults to grid on server and first client render (see `ViewToggle`); the
     * stored preference from `localStorage` is applied after mount to avoid a hydration mismatch. */
    viewMode: 'grid' as 'grid' | 'list',
  }),
})
