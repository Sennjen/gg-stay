<script setup lang="ts">
import { SEARCH_THUMBNAIL_IMAGE_SIZES } from '~/utils/rawgImage'

const MIN_LENGTH = 2

const route = useRoute()
const router = useRouter()
const localePath = useLocalePath()
const { t } = useI18n()

const rootRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)
const toggleRef = ref<HTMLButtonElement | null>(null)
const inputId = useId()
const listboxId = useId()
const viewAllId = `${listboxId}-view-all`

const { term, items, status, reset } = useSearchSuggestions()

/** Only reads the `search` param while on the catalog route, for the current locale. */
function catalogSearchTerm(): string {
  return route.path === localePath('/games') ? String(route.query.search ?? '') : ''
}

// The text shown in the input. Kept separate from `useSearchSuggestions`'s
// own `term` (which drives the debounced fetch): a catalog `search` param
// pre-fills this on both server and client, but must never by itself fire a
// request or open the dropdown — only an explicit user action does that (see
// `interacted` below). `term` is only ever written to from that action.
const inputText = ref(catalogSearchTerm())

// Starts `false` identically on the server and on the client's first render
// (no hydration mismatch), and flips to `true` only from a real user action:
// typing, or pressing ArrowDown/ArrowUp while focused. Never from the
// pre-filled route value alone.
const interacted = ref(false)
const dismissed = ref(false)
const activeIndex = ref(-1)
const mobileExpanded = ref(false)

const showDropdown = computed(
  () => interacted.value && !dismissed.value && inputText.value.trim().length >= MIN_LENGTH,
)
const optionCount = computed(() => items.value.length + 1) // +1 for the "all results" row

const activeOptionId = computed(() => {
  if (!showDropdown.value || activeIndex.value < 0) return undefined
  return activeIndex.value < items.value.length
    ? `${listboxId}-option-${activeIndex.value}`
    : viewAllId
})

const liveMessage = computed(() => {
  if (!showDropdown.value || status.value !== 'success') return ''
  return t('search.resultsAnnouncement', { count: items.value.length })
})

function optionId(index: number) {
  return `${listboxId}-option-${index}`
}

function releaseYear(iso: string) {
  return iso.slice(0, 4)
}

function onInput(event: Event) {
  dismissed.value = false
  interacted.value = true
  activeIndex.value = -1
  inputText.value = (event.target as HTMLInputElement).value
  term.value = inputText.value
}

function onFocus() {
  dismissed.value = false
}

function collapseMobile({ returnFocus }: { returnFocus: boolean }) {
  if (!mobileExpanded.value) return
  mobileExpanded.value = false
  if (returnFocus) nextTick(() => toggleRef.value?.focus())
}

function onEscape() {
  dismissed.value = true
  collapseMobile({ returnFocus: true })
}

function moveActive(delta: 1 | -1) {
  if (!interacted.value) {
    // First arrow key press while focused, before any typing: treat it as an
    // explicit request to search the text already shown (e.g. a pre-filled
    // catalog term) rather than opening on the pre-fill by itself.
    if (inputText.value.trim().length < MIN_LENGTH) return
    interacted.value = true
    term.value = inputText.value
    return
  }
  if (!showDropdown.value) return
  const count = optionCount.value
  if (activeIndex.value < 0) {
    activeIndex.value = delta > 0 ? 0 : count - 1
  } else {
    activeIndex.value = (activeIndex.value + delta + count) % count
  }
}

function goToGame(slug: string) {
  dismissed.value = true
  router.push(localePath(`/games/${slug}`))
}

function goToAllResults() {
  const trimmed = inputText.value.trim()
  if (!trimmed) return
  dismissed.value = true
  router.push({ path: localePath('/games'), query: { search: trimmed } })
}

function onEnter() {
  if (showDropdown.value && activeIndex.value >= 0) {
    if (activeIndex.value < items.value.length) {
      goToGame(items.value[activeIndex.value]!.slug)
    } else {
      goToAllResults()
    }
    return
  }
  goToAllResults()
}

function expandMobile() {
  mobileExpanded.value = true
  nextTick(() => inputRef.value?.focus())
}

function onDocumentPointerDown(event: PointerEvent) {
  if (!rootRef.value) return
  if (event.target instanceof Node && rootRef.value.contains(event.target)) return
  dismissed.value = true
  collapseMobile({ returnFocus: true })
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointerDown))

// Route change (including the navigations this component itself triggers)
// closes the dropdown and resets the text/search session to whatever the new
// route implies — without stealing focus (unlike Escape/outside-click, this
// isn't a user action directed at the search box itself).
watch(
  () => route.fullPath,
  () => {
    dismissed.value = true
    interacted.value = false
    activeIndex.value = -1
    collapseMobile({ returnFocus: false })
    inputText.value = catalogSearchTerm()
    reset()
  },
)

onBeforeUnmount(() => reset())
</script>

<template>
  <div
    ref="rootRef"
    :class="
      mobileExpanded
        ? 'absolute inset-0 z-10 flex items-center bg-surface-1 px-4 md:static md:inset-auto md:z-auto md:bg-transparent md:px-0'
        : 'relative'
    "
  >
    <button
      v-if="!mobileExpanded"
      ref="toggleRef"
      type="button"
      class="text-fg focus-visible:outline-2 md:hidden"
      :aria-label="t('search.label')"
      @click="expandMobile"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </svg>
    </button>

    <div :class="mobileExpanded ? 'w-full' : 'hidden md:block md:w-[360px]'">
      <label :for="inputId" class="sr-only">{{ t('search.label') }}</label>
      <input
        :id="inputId"
        ref="inputRef"
        type="text"
        role="combobox"
        autocomplete="off"
        spellcheck="false"
        :value="inputText"
        :placeholder="t('search.placeholder')"
        aria-autocomplete="list"
        :aria-expanded="showDropdown"
        :aria-controls="listboxId"
        :aria-activedescendant="activeOptionId"
        class="w-full rounded-chip border border-line bg-surface-1 px-3 py-1.5 text-sm text-fg placeholder:text-fg-2 focus-visible:outline-2"
        @input="onInput"
        @focus="onFocus"
        @keydown.down.prevent="moveActive(1)"
        @keydown.up.prevent="moveActive(-1)"
        @keydown.esc="onEscape"
        @keydown.enter.prevent="onEnter"
      />

      <ul
        v-if="showDropdown"
        :id="listboxId"
        role="listbox"
        :aria-label="t('search.label')"
        class="absolute z-50 mt-1 w-full overflow-hidden rounded-card border border-line bg-surface-1 shadow-lg"
      >
        <li v-if="status === 'loading'" role="presentation" class="px-3 py-2 text-sm text-fg-2">
          {{ t('search.loading') }}
        </li>
        <li v-else-if="status === 'error'" role="presentation" class="px-3 py-2 text-sm text-fg-2">
          {{ t('search.error') }}
        </li>
        <li v-else-if="items.length === 0" role="presentation" class="px-3 py-2 text-sm text-fg-2">
          {{ t('search.empty') }}
        </li>
        <li
          v-for="(game, index) in items"
          :id="optionId(index)"
          :key="game.id"
          role="option"
          :aria-selected="activeIndex === index"
          class="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm text-fg"
          :class="activeIndex === index ? 'bg-surface-2' : ''"
          @mousedown.prevent="goToGame(game.slug)"
          @mouseenter="activeIndex = index"
        >
          <NuxtImg
            v-if="game.cover"
            :src="game.cover.url"
            alt=""
            width="96"
            height="54"
            :sizes="SEARCH_THUMBNAIL_IMAGE_SIZES"
            loading="lazy"
            class="h-[54px] w-24 flex-none rounded object-cover"
          />
          <div v-else class="h-[54px] w-24 flex-none rounded bg-surface-2" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate">{{ game.name }}</span>
          <span v-if="game.released" class="font-numeric flex-none text-xs text-fg-2">{{
            releaseYear(game.released)
          }}</span>
        </li>
        <li
          :id="viewAllId"
          role="option"
          :aria-selected="activeIndex === items.length"
          class="cursor-pointer px-3 py-2 text-sm text-fg"
          :class="activeIndex === items.length ? 'bg-surface-2' : ''"
          @mousedown.prevent="goToAllResults"
          @mouseenter="activeIndex = items.length"
        >
          {{ t('search.allResults', { term: inputText.trim() }) }}
        </li>
      </ul>

      <p class="sr-only" aria-live="polite">{{ liveMessage }}</p>
    </div>
  </div>
</template>
