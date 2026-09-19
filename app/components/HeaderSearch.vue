<script setup lang="ts">
const MIN_LENGTH = 2

const route = useRoute()
const router = useRouter()
const localePath = useLocalePath()
const { t } = useI18n()

const rootRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)
const inputId = useId()
const listboxId = useId()
const viewAllId = `${listboxId}-view-all`

const { term, items, status, reset } = useSearchSuggestions()

/** Only reads the `search` param while on the catalog route, for the current locale. */
function catalogSearchTerm(): string {
  return route.path === localePath('/games') ? String(route.query.search ?? '') : ''
}
term.value = catalogSearchTerm()

const dismissed = ref(false)
const activeIndex = ref(-1)
const mobileExpanded = ref(false)

const showDropdown = computed(() => !dismissed.value && term.value.trim().length >= MIN_LENGTH)
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
  activeIndex.value = -1
  term.value = (event.target as HTMLInputElement).value
}

function onFocus() {
  dismissed.value = false
}

function onEscape() {
  dismissed.value = true
}

function moveActive(delta: 1 | -1) {
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
  const trimmed = term.value.trim()
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
  mobileExpanded.value = false
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointerDown))

// Route change (including the navigations this component itself triggers)
// closes the dropdown and resets the text to whatever the new route implies.
watch(
  () => route.fullPath,
  () => {
    dismissed.value = true
    activeIndex.value = -1
    mobileExpanded.value = false
    term.value = catalogSearchTerm()
  },
)

onBeforeUnmount(() => reset())
</script>

<template>
  <div ref="rootRef" class="relative">
    <button
      v-if="!mobileExpanded"
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
        :value="term"
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
          {{ t('search.allResults', { term: term.trim() }) }}
        </li>
      </ul>

      <p class="sr-only" aria-live="polite">{{ liveMessage }}</p>
    </div>
  </div>
</template>
