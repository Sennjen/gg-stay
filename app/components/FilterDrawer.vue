<script setup lang="ts">
/**
 * Modal filter drawer: left slide-in on >= 1024px, bottom sheet below.
 * `panelOpen` lives in the filters store so the top-bar trigger and this
 * component share it without prop drilling.
 *
 * SSR: the dialog markup only mounts after the first open (`hasOpened`),
 * not on the initial server render. It owns three client-only concerns —
 * a document-level keydown listener for the focus trap and Escape, a
 * `document.body.style.overflow` scroll lock, and returning focus to the
 * element that opened it — none of which has a meaningful SSR
 * representation, and rendering the closed dialog on the server would only
 * add dead markup a crawler never sees (it is not part of the catalog's
 * indexable content). Lazy-mounting avoids all of that for no real cost,
 * since the drawer is opened by a click, which only happens client-side.
 */
const props = defineProps<{ resultTotal: number; triggerEl?: HTMLElement | null }>()
const emit = defineEmits<{ reset: [] }>()
const { t } = useI18n()
const store = useFiltersStore()

const hasOpened = ref(false)
const panelRef = ref<HTMLElement | null>(null)
const closeButtonRef = ref<HTMLButtonElement | null>(null)
const titleId = 'filter-drawer-title'

let previouslyFocused: HTMLElement | null = null

function focusableEls(): HTMLElement[] {
  if (!panelRef.value) return []
  return Array.from(
    panelRef.value.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  )
}

function close() {
  store.panelOpen = false
}

function reset() {
  emit('reset')
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab') return
  const els = focusableEls()
  if (!els.length) return
  const first = els[0]!
  const last = els[els.length - 1]!
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(
  () => store.panelOpen,
  async (isOpen) => {
    if (isOpen) {
      hasOpened.value = true
      previouslyFocused = (document.activeElement as HTMLElement) ?? null
      document.body.style.overflow = 'hidden'
      document.addEventListener('keydown', onKeydown)
      await nextTick()
      closeButtonRef.value?.focus()
    } else {
      document.body.style.overflow = ''
      document.removeEventListener('keydown', onKeydown)
      ;(props.triggerEl ?? previouslyFocused)?.focus()
    }
  },
)

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport v-if="hasOpened" to="body">
    <Transition
      enter-active-class="transition-opacity duration-200 ease-out motion-reduce:duration-0"
      leave-active-class="transition-opacity duration-200 ease-out motion-reduce:duration-0"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div
        v-if="store.panelOpen"
        class="fixed inset-0 z-40 bg-ink/60 backdrop-blur-sm"
        @click="close"
      />
    </Transition>
    <Transition
      enter-active-class="transition-transform duration-200 ease-out motion-reduce:duration-0"
      leave-active-class="transition-transform duration-200 ease-out motion-reduce:duration-0"
      enter-from-class="translate-y-full lg:translate-y-0 lg:-translate-x-full"
      enter-to-class="translate-y-0 lg:translate-x-0"
      leave-from-class="translate-y-0 lg:translate-x-0"
      leave-to-class="translate-y-full lg:translate-y-0 lg:-translate-x-full"
    >
      <div
        v-if="store.panelOpen"
        ref="panelRef"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        class="fixed inset-x-0 bottom-0 z-40 flex max-h-[85vh] flex-col rounded-t-card border-t border-line bg-surface-1 lg:inset-y-0 lg:right-auto lg:left-0 lg:h-full lg:max-h-none lg:w-[360px] lg:rounded-none lg:rounded-r-card lg:border-t-0 lg:border-r"
      >
        <div class="flex items-center justify-between border-b border-line p-4">
          <h2 :id="titleId" class="font-display-heading text-lg text-fg">
            {{ t('drawer.title') }}
          </h2>
          <button
            ref="closeButtonRef"
            type="button"
            :aria-label="t('drawer.close')"
            class="flex size-8 items-center justify-center rounded-full text-fg-2 hover:text-fg focus-visible:outline-2"
            @click="close"
          >
            ×
          </button>
        </div>

        <div class="flex-1 overflow-y-auto p-4">
          <slot />
        </div>

        <div class="sticky bottom-0 flex gap-3 border-t border-line bg-surface-1 p-4">
          <button
            type="button"
            class="flex-1 rounded-chip bg-accent px-4 py-2 text-sm font-semibold text-on-accent focus-visible:outline-2"
            @click="close"
          >
            <i18n-t keypath="drawer.showResults" tag="span">
              <template #count
                ><span class="font-numeric">{{ resultTotal }}</span></template
              >
            </i18n-t>
          </button>
          <button
            type="button"
            class="rounded-chip border border-signal px-4 py-2 text-sm text-signal focus-visible:outline-2"
            @click="reset"
          >
            {{ t('drawer.resetAll') }}
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
