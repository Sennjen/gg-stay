import { defineStore } from 'pinia'

/** In-memory companion of the URL state: survives navigation, never persisted. */
export const useFiltersStore = defineStore('filters', {
  state: () => ({
    /** Last catalog query, so the detail page can link back to the same filtered list. */
    lastCatalogQuery: {} as Record<string, string>,
    /** Mobile filter drawer. */
    panelOpen: false,
  }),
})
