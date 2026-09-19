import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import Pagination from '~/components/Pagination.vue'
import { buildPageList } from '~/utils/buildPageList'

describe('buildPageList', () => {
  const cases: [current: number, total: number, expected: (number | 'ellipsis')[]][] = [
    [1, 1, [1]],
    [1, 3, [1, 2, 3]],
    [1, 5, [1, 2, 'ellipsis', 5]],
    [1, 40, [1, 2, 'ellipsis', 40]],
    [2, 40, [1, 2, 3, 'ellipsis', 40]],
    [20, 40, [1, 'ellipsis', 19, 20, 21, 'ellipsis', 40]],
    [39, 40, [1, 'ellipsis', 38, 39, 40]],
    [40, 40, [1, 'ellipsis', 39, 40]],
    [3, 5, [1, 2, 3, 4, 5]],
  ]

  it.each(cases)('current=%i total=%i -> %j', (current, total, expected) => {
    expect(buildPageList(current, total)).toEqual(expected)
  })
})

describe('Pagination', () => {
  it('disables "previous" on the first page and emits the next page on click', async () => {
    const wrapper = await mountSuspended(Pagination, { props: { page: 1, totalPages: 3 } })
    const links = wrapper.findAll('a')
    const prev = links[0]!
    const next = links[links.length - 1]!
    expect(prev.attributes('aria-disabled')).toBe('true')
    await next.trigger('click')
    expect(wrapper.emitted('change')).toEqual([[2]])
  })

  it('disables "next" on the last page and emits the previous page on click', async () => {
    const wrapper = await mountSuspended(Pagination, { props: { page: 3, totalPages: 3 } })
    const links = wrapper.findAll('a')
    const prev = links[0]!
    const next = links[links.length - 1]!
    expect(next.attributes('aria-disabled')).toBe('true')
    await prev.trigger('click')
    expect(wrapper.emitted('change')).toEqual([[2]])
  })

  it('marks the current page with aria-current and emits it on click', async () => {
    const wrapper = await mountSuspended(Pagination, {
      props: { page: 2, totalPages: 3 },
    })
    const current = wrapper.findAll('a[aria-current="page"]')
    expect(current).toHaveLength(1)
    expect(current[0]!.text()).toBe('2')

    const pageLinks = wrapper.findAll('a')
    const pageTwo = pageLinks.find((link) => link.text() === '2')!
    await pageTwo.trigger('click')
    expect(wrapper.emitted('change')).toEqual([[2]])
  })

  it('keeps other query params in each page href', async () => {
    const wrapper = await mountSuspended(Pagination, {
      props: { page: 2, totalPages: 5 },
      route: '/games?genres=rpg&sort=NAME_ASC&page=2',
    })
    const pageThree = wrapper.findAll('a').find((link) => link.text() === '3')!
    expect(pageThree.attributes('href')).toContain('genres=rpg')
    expect(pageThree.attributes('href')).toContain('sort=NAME_ASC')
    expect(pageThree.attributes('href')).toContain('page=3')

    const pageOne = wrapper.findAll('a').find((link) => link.text() === '1')!
    expect(pageOne.attributes('href')).not.toContain('page=')
  })
})
