/**
 * The catalog's URL layer. It lives in `shared/` because the server builds catalog links with it
 * too (the `/api/ask` answer's `catalogUrl`); the app keeps importing it from here.
 */
export {
  DEFAULT_SORT,
  INDEX_FILTER_FIELDS,
  countActiveFilters,
  parseFilterQuery,
  serializeFilterState,
} from '#shared/filterUrl'
export type { CatalogFilter, CatalogState } from '#shared/filterUrl'
