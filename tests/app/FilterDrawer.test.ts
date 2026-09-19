import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, nextTick, ref } from 'vue'
import type { VueWrapper } from '@vue/test-utils'
import FilterDrawer from '~/components/FilterDrawer.vue'
import { useFiltersStore } from '~/stores/filters'

/**
 * `FilterDrawer` is opened by a trigger button that lives outside it (the
 * catalog top bar); this host mirrors that shape so the tests exercise the
 * same store-driven open/close and focus-return contract as production.
 */
const Host = defineComponent({
  components: { FilterDrawer },
  emits: ['reset'],
  setup(_, { emit }) {
    const store = useFiltersStore()
    const triggerRef = ref<HTMLButtonElement>()
    return { store, triggerRef, emit }
  },
  template: `
    <div>
      <button ref="triggerRef" type="button" @click="store.panelOpen = true">open filters</button>
      <FilterDrawer :result-total="42" :trigger-el="triggerRef" @reset="emit('reset')">
        <button type="button">option A</button>
      </FilterDrawer>
    </div>
  `,
})

let wrapper: VueWrapper | undefined

async function mountHost() {
  wrapper = (await mountSuspended(Host, { attachTo: document.body })) as VueWrapper
  return wrapper
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.style.overflow = ''
  // The filters store is a singleton for the test file; reset `panelOpen` so a
  // still-open drawer from one test can't suppress the next test's open watcher
  // (it only fires on a `false -> true` transition).
  useFiltersStore().$reset()
})

describe('FilterDrawer', () => {
  it('is closed until the trigger is clicked, then renders a labelled modal dialog', async () => {
    const host = await mountHost()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()

    await host.get('button').trigger('click')
    await nextTick()

    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Фільтри',
    )
  })

  it('moves focus into the dialog on open and returns it to the trigger on Escape', async () => {
    const host = await mountHost()
    const trigger = host.get('button').element as HTMLButtonElement
    await host.get('button').trigger('click')
    await nextTick()
    await nextTick()

    expect(document.activeElement?.getAttribute('aria-label')).toBe('Закрити')

    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await nextTick()

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('traps Tab inside the dialog: Tab from the last element wraps to the first', async () => {
    const host = await mountHost()
    await host.get('button').trigger('click')
    await nextTick()
    await nextTick()

    const dialog = document.body.querySelector('[role="dialog"]')!
    const focusable = [...dialog.querySelectorAll('button')] as HTMLButtonElement[]
    const last = focusable[focusable.length - 1]!
    last.focus()

    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    await nextTick()

    expect(document.activeElement).toBe(focusable[0])
  })

  it('clicking the backdrop closes the drawer', async () => {
    const host = await mountHost()
    await host.get('button').trigger('click')
    await nextTick()

    const backdrop = document.body.querySelector<HTMLElement>('.bg-ink\\/60')!
    backdrop.click()
    await nextTick()

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('choosing an option inside does not close the drawer', async () => {
    const host = await mountHost()
    await host.get('button').trigger('click')
    await nextTick()

    const option = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'option A',
    )!
    option.click()
    await nextTick()

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('the footer button shows the current total and closes the drawer on click', async () => {
    const host = await mountHost()
    await host.get('button').trigger('click')
    await nextTick()

    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('42')
    expect(dialog.textContent).toContain('Показати')

    const showButton = [...dialog.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Показати'),
    )!
    showButton.click()
    await nextTick()

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })
})
