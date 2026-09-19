/**
 * First page, last page, the current page and its immediate neighbours; a gap
 * between two kept pages becomes a single `'ellipsis'` entry. Used by
 * `Pagination.vue` to render "1 2 3 … 40" style numbered pagination.
 */
export function buildPageList(current: number, total: number): (number | 'ellipsis')[] {
  if (total <= 1) return [1]
  const keep = new Set<number>([1, total])
  for (let page = current - 1; page <= current + 1; page++) {
    if (page >= 1 && page <= total) keep.add(page)
  }
  const sorted = [...keep].sort((a, b) => a - b)
  const result: (number | 'ellipsis')[] = []
  let previous = 0
  for (const page of sorted) {
    if (previous && page - previous > 1) result.push('ellipsis')
    result.push(page)
    previous = page
  }
  return result
}
