<script setup lang="ts">
import { CatalogTaxonomiesDocument } from '~/graphql/__generated__/operations'
import {
  ASK_MAX_LENGTH,
  askCatalogQuery,
  askIgnoredSort,
  normaliseAskQuery,
} from '~/utils/askAnswer'
import { OG_IMAGE, askRobots, trimDescription, withSiteName } from '~/utils/seo'

/** How much of the question a page title may carry before it is cut on a word boundary. */
const TITLE_QUERY_LIMIT = 60

/** The three example questions, in the order the page offers them. */
const EXAMPLE_KEYS = ['coop', 'horror', 'hades'] as const

/** The rows whose covers load at once: the ones a first screen can hold under the form. */
const EAGER_COVERS = 2

/** How long Gege stays pleased with an answer before he goes back to idling. */
const HAPPY_MS = 1500

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const localePath = useLocalePath()

// The question lives in the URL (`?q=`), so a result is a link: the server renders it, and the
// form only ever navigates. `draft` is what the field shows, seeded from the URL and re-seeded
// when the URL changes (an example, the back button).
const urlQuery = computed(() => normaliseAskQuery(route.query.q))

const [ask, taxonomies] = await Promise.all([
  useAskAnswer(urlQuery),
  useGql(CatalogTaxonomiesDocument, {}),
])
const { answer, failure, status } = ask
const genres = computed(() => taxonomies.data.value?.genres ?? [])

const draft = ref(urlQuery.value)
watch(urlQuery, (value) => {
  draft.value = value
})

type View = 'idle' | 'loading' | 'error' | 'empty' | 'results'
const view = computed<View>(() => {
  if (!ask.query.value) return 'idle'
  if (status.value === 'pending') return 'loading'
  if (failure.value) return 'error'
  if (!answer.value) return 'loading'
  return answer.value.items.length ? 'results' : 'empty'
})
const isFallback = computed(() => answer.value?.mode === 'fallback')
// The link is offered only when it would narrow the catalog. A "like X" answer, or one where
// nothing was understood, has no filter the catalog's URL can carry, and the link would open the
// whole catalog — which shows none of these games — under a label promising the understood filter.
const catalogLink = computed(() => {
  if (!answer.value) return null
  const query = askCatalogQuery(answer.value.catalogUrl, answer.value.filter)
  return Object.keys(query).length ? { path: localePath('/games'), query } : null
})
// What the catalog could not apply, marked as the catalog marks it: struck-through chips with the
// reason beside them, the declined sort named in the catalog's words, and the catalog's stale
// banner when stale prices are why. Both come from the answer, from the same catalog page its cards
// came from, so the reason given always matches the filters declined.
const ignoredFilters = computed<readonly string[]>(() => answer.value?.ignoredFilters ?? [])
const indexStale = computed(() => answer.value?.indexStale ?? false)
const PRICE_FIELDS: readonly string[] = ['priceMaxUah', 'free', 'onSaleMinPercent', 'sort']
const showStaleBanner = computed(
  () => indexStale.value && ignoredFilters.value.some((field) => PRICE_FIELDS.includes(field)),
)
const ignoredSort = computed(() =>
  answer.value ? askIgnoredSort(answer.value.catalogUrl, ignoredFilters.value) : null,
)
// The one list of games: the count line and the rows are both made from it.
const results = computed(() => answer.value?.items ?? [])
const itemCount = computed(() => results.value.length)
const countKey = computed(() => (isFallback.value ? 'ask.found' : 'ask.picked'))

/**
 * What the live region says. It follows the state rather than being set by the submit handler,
 * so the server and the hydrated client agree on it; the visitor hears it change when a question
 * they sent comes back. Failures are not repeated here: their own block is `role="alert"`.
 */
const liveMessage = computed(() => {
  switch (view.value) {
    // The first of the waiting lines, once: the lines that follow it on screen are not announced.
    case 'loading':
      return t('ask.waiting.reading')
    case 'empty':
      return t('ask.emptyTitle')
    case 'results': {
      const count = t(countKey.value, { count: itemCount.value }, { plural: itemCount.value })
      return isFallback.value ? `${t('ask.fallbackNote')}. ${count}` : count
    }
    default:
      return ''
  }
})

const fieldId = useId()
const counterId = useId()
const privacyId = useId()
const emptyQuestionId = useId()
const resultsHeadingId = useId()
const outcomeId = useId()
const fallbackNoteId = useId()
const fieldRef = ref<HTMLTextAreaElement | null>(null)
const resultsHeadingRef = ref<HTMLHeadingElement | null>(null)
const examplesRef = ref<HTMLElement | null>(null)
const emptyQuestion = ref(false)
const describedBy = computed(() =>
  [counterId, emptyQuestion.value ? emptyQuestionId : null, privacyId].filter(Boolean).join(' '),
)

// Set by a submit, cleared once the answer it asked for has landed and focus has moved to it. A
// first load from a shared URL never moves focus: the visitor did not just ask anything. Neither
// does history: a visitor who leaves for the plain page while waiting has dropped the question, and
// an answer they page back to later is not one they just asked for.
const focusResultsWhenReady = ref(false)
watch(view, async (next) => {
  if (next === 'idle') focusResultsWhenReady.value = false
  if (!focusResultsWhenReady.value || next === 'loading') return
  focusResultsWhenReady.value = false
  await nextTick()
  resultsHeadingRef.value?.focus()
})

// Moving focus cuts off whatever a screen reader was about to say politely, and the status region
// changes in the same breath as the focus move. So the outcome — the count, with the plain-search
// note before it, or the empty answer — is also the heading's description, by the ids of the
// lines that show it: it is read with the
// heading that takes focus, and the visitor hears "Results, picked 8 games" whichever of the two
// the screen reader lets through. A failure needs none: its block is an alert, which is spoken
// over a focus change.
const outcomeDescribes = computed(() => {
  if (view.value !== 'results' && view.value !== 'empty') return undefined
  return isFallback.value ? `${fallbackNoteId} ${outcomeId}` : outcomeId
})

// Counts the questions sent from this page. The waiting lines are keyed by it, so a question sent
// while another is still being answered starts its own wait from the first line.
const asked = ref(0)

// Gege is pleased once per answer he picked himself: when it is rendered, and again when another
// takes its place. A plain search, an empty answer and a failure leave him as he was.
const pleased = ref(true)
let pleasedTimer: ReturnType<typeof setTimeout> | null = null
function cheer() {
  if (pleasedTimer !== null) clearTimeout(pleasedTimer)
  pleased.value = true
  pleasedTimer = setTimeout(() => {
    pleasedTimer = null
    pleased.value = false
  }, HAPPY_MS)
}
const answerMood = computed(() =>
  view.value === 'results' && !isFallback.value && pleased.value ? 'happy' : 'idle',
)
onMounted(() => {
  cheer()
  watch(answer, cheer)
})
onBeforeUnmount(() => {
  if (pleasedTimer !== null) clearTimeout(pleasedTimer)
})

async function submit(text: string = draft.value, event?: MouseEvent) {
  const question = text.trim()
  if (!question) {
    emptyQuestion.value = true
    fieldRef.value?.focus()
    return
  }
  emptyQuestion.value = false
  draft.value = question
  focusResultsWhenReady.value = true
  asked.value += 1
  // The examples leave the page with the first question, and a chip pressed from the keyboard
  // would take focus with it, down to the document, for the whole wait. The field now holds that
  // question, so focus goes there. A tap or a mouse click (`detail` counts the clicks; the
  // keyboard's is 0) is left alone: focusing the field would only raise a phone's keyboard over
  // the answer.
  if (event?.detail === 0 && examplesRef.value?.contains(document.activeElement)) {
    fieldRef.value?.focus()
  }
  // A question sent from the form is asked again even if this tab has its answer; only history
  // navigation renders from memory.
  ask.forget(question)
  if (question === urlQuery.value) {
    await ask.refresh()
    return
  }
  await router.push({ path: localePath('/ask'), query: { q: question } })
}

function onInput() {
  if (draft.value.trim()) emptyQuestion.value = false
}

// Enter sends, as in any search field; Shift+Enter still breaks the line, and Enter that confirms
// an IME composition is left to the IME.
function onEnter(event: KeyboardEvent) {
  if (event.shiftKey || event.isComposing) return
  event.preventDefault()
  submit()
}

const robots = useRobots()
const { absoluteUrl } = useSiteUrl()
const headTitle = computed(() =>
  urlQuery.value
    ? t('ask.titleQuery', { query: trimDescription(urlQuery.value, TITLE_QUERY_LIMIT) })
    : t('ask.title'),
)

useSeoMeta({
  title: () => withSiteName(headTitle.value),
  description: () => t('ask.description'),
  robots: () => robots(askRobots(urlQuery.value)),
  ogTitle: () => headTitle.value,
  ogDescription: () => t('ask.description'),
  ogImage: absoluteUrl(OG_IMAGE.path),
  ogImageWidth: OG_IMAGE.width,
  ogImageHeight: OG_IMAGE.height,
  ogImageType: 'image/png',
  ogImageAlt: () => t('home.shareImageAlt'),
})
</script>

<template>
  <div class="mx-auto max-w-3xl">
    <!-- Gege opens the page; once there is a question he moves down to the answer, and the heading
         stays behind as a plain line so the form and the answer share the first screen. -->
    <GegeSpeech v-if="view === 'idle'" variant="lead" :size="100" data-test="ask-intro">
      <div class="px-5 py-4">
        <h1 class="font-display-heading text-xl text-fg sm:text-2xl">{{ t('ask.intro.title') }}</h1>
        <p class="mt-2 text-fg-2">{{ t('ask.intro.text') }}</p>
      </div>
    </GegeSpeech>
    <h1 v-else class="font-display-heading text-xl text-fg sm:text-2xl">
      {{ t('ask.intro.title') }}
    </h1>

    <form
      role="search"
      :aria-labelledby="`${fieldId}-label`"
      class="mt-6"
      novalidate
      @submit.prevent="submit()"
    >
      <label :id="`${fieldId}-label`" :for="fieldId" class="block text-sm font-medium text-fg">{{
        t('ask.label')
      }}</label>
      <!-- One box for the field, its counter and the button, and the box wears the focus ring: the
           field inside it has no edge of its own to draw one on. -->
      <div
        class="mt-2 rounded-card border border-line bg-surface-1 outline-offset-2 outline-accent transition-colors duration-200 ease-out hover:border-fg-2 has-[textarea:focus-visible]:border-fg-2 has-[textarea:focus-visible]:outline-2"
      >
        <textarea
          :id="fieldId"
          ref="fieldRef"
          v-model="draft"
          name="q"
          rows="3"
          :maxlength="ASK_MAX_LENGTH"
          :aria-describedby="describedBy"
          :aria-invalid="emptyQuestion ? 'true' : undefined"
          class="ask-field block max-h-48 w-full resize-none field-sizing-content bg-transparent px-4 pt-3 pb-1 text-base text-fg"
          @input="onInput"
          @keydown.enter="onEnter"
        />
        <div class="flex items-center justify-between gap-3 py-2 pr-2 pl-4">
          <i18n-t
            :id="counterId"
            keypath="ask.counter"
            tag="p"
            data-test="ask-counter"
            class="text-sm text-fg-2"
          >
            <template #count
              ><span class="font-numeric">{{ draft.length }}</span></template
            >
            <template #max
              ><span class="font-numeric">{{ ASK_MAX_LENGTH }}</span></template
            >
          </i18n-t>
          <button
            type="submit"
            class="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-chip bg-accent px-6 font-medium text-on-accent focus-visible:outline-2"
          >
            {{ t('ask.submit') }}
          </button>
        </div>
      </div>
      <p
        v-if="emptyQuestion"
        :id="emptyQuestionId"
        data-test="ask-empty-question"
        class="mt-2 text-sm text-fg"
      >
        {{ t('ask.emptyQuestion') }}
      </p>
    </form>

    <!-- His suggestions, offered while there is nothing on the page yet; each one asks at once. -->
    <div v-if="view === 'idle'" ref="examplesRef" data-test="ask-examples" class="mt-5">
      <p :id="`${fieldId}-examples`" class="flex items-center gap-2 text-sm text-fg-2">
        <GegeMascot :size="20" :animated="false" />
        {{ t('ask.examplesLabel') }}
      </p>
      <ul :aria-labelledby="`${fieldId}-examples`" class="mt-2 flex flex-wrap gap-2">
        <li v-for="key in EXAMPLE_KEYS" :key="key">
          <button
            type="button"
            class="min-h-11 cursor-pointer rounded-chip border border-line bg-surface-1 px-4 py-2 text-left text-sm text-fg transition-colors duration-150 ease-out hover:border-fg-2 hover:bg-surface-2 focus-visible:outline-2"
            @click="submit(t(`ask.examples.${key}`), $event)"
          >
            {{ t(`ask.examples.${key}`) }}
          </button>
        </li>
      </ul>
    </div>

    <p :id="privacyId" class="mt-5 text-xs text-fg-2">{{ t('ask.privacy') }}</p>

    <p data-test="ask-live" role="status" class="sr-only">{{ liveMessage }}</p>

    <section
      v-if="view !== 'idle'"
      data-test="ask-results"
      class="mt-8 border-t border-line pt-6"
      :aria-labelledby="resultsHeadingId"
      :aria-busy="view === 'loading' ? 'true' : undefined"
    >
      <h2
        :id="resultsHeadingId"
        ref="resultsHeadingRef"
        tabindex="-1"
        :aria-describedby="outcomeDescribes"
        class="w-fit font-display-heading text-lg text-fg focus-visible:outline-2"
      >
        {{ t('ask.results') }}
      </h2>

      <AskWaiting v-if="view === 'loading'" :key="asked" class="mt-4" />

      <GegeSpeech v-else-if="view === 'error' && failure" class="mt-4">
        <div data-test="ask-error" role="alert" class="p-4 text-fg">
          <i18n-t
            v-if="failure.kind === 'rate-limited' && failure.retryAfterSeconds"
            keypath="ask.errorRateLimited"
            tag="p"
            :plural="failure.retryAfterSeconds"
          >
            <template #count
              ><span class="font-numeric">{{ failure.retryAfterSeconds }}</span></template
            >
          </i18n-t>
          <p v-else-if="failure.kind === 'rate-limited'">{{ t('ask.errorRateLimitedMinute') }}</p>
          <i18n-t v-else-if="failure.kind === 'invalid'" keypath="ask.errorInvalid" tag="p">
            <template #max
              ><span class="font-numeric">{{ ASK_MAX_LENGTH }}</span></template
            >
          </i18n-t>
          <p v-else>{{ t('ask.errorFailed') }}</p>
          <button
            v-if="failure.kind !== 'invalid'"
            type="button"
            class="mt-3 inline-flex min-h-11 cursor-pointer items-center justify-center rounded-chip bg-accent px-5 font-medium text-on-accent focus-visible:outline-2"
            @click="submit(urlQuery)"
          >
            {{ t('errors.retry') }}
          </button>
        </div>
      </GegeSpeech>

      <template v-else-if="answer">
        <CatalogStaleBanner v-if="showStaleBanner" class="mt-4" />
        <!-- Keyed by the question: an answer that replaces another from memory (Back, Forward) is
             a new line of his, with its own moment of being pleased. -->
        <GegeSpeech :key="ask.query.value" :mood="answerMood" class="mt-4" data-test="ask-answer">
          <div class="space-y-3 p-4">
            <p v-if="isFallback" :id="fallbackNoteId" data-test="ask-fallback-note" class="text-fg">
              {{ t('ask.fallbackNote') }}
            </p>
            <i18n-t
              v-else-if="answer.interpretation"
              keypath="ask.understood"
              tag="p"
              data-test="ask-interpretation"
              class="text-fg-2"
            >
              <template #interpretation
                ><span class="font-medium break-words text-fg">{{
                  answer.interpretation
                }}</span></template
              >
            </i18n-t>

            <div
              v-if="catalogLink"
              data-test="ask-filter-row"
              class="flex flex-wrap items-center gap-x-3 gap-y-2"
            >
              <ReadonlyFilterChips
                data-test="ask-filter"
                :filter="answer.filter"
                :genres="genres"
                :label="isFallback ? t('ask.searchLabel') : t('ask.filterLabel')"
                :ignored="ignoredFilters"
                :index-stale="indexStale"
              />
              <p v-if="ignoredSort" data-test="ask-sort-ignored" class="text-xs text-fg-2">
                {{ t('catalog.sortIgnored', { name: t(`sorts.${ignoredSort}`) }) }}
              </p>
              <!-- A plain underlined link, not a chip: next to the chips it must not read as one
                   more filter value. -->
              <NuxtLink
                :to="catalogLink"
                data-test="ask-catalog-link"
                class="text-sm text-fg underline underline-offset-4 hover:text-fg-2 focus-visible:outline-2"
              >
                {{ t('ask.openInCatalog') }}
              </NuxtLink>
            </div>

            <div v-if="view === 'empty'" data-test="ask-empty">
              <p :id="outcomeId" class="font-semibold text-fg">{{ t('ask.emptyTitle') }}</p>
              <p class="mt-1 text-fg-2">
                {{ catalogLink ? t('ask.emptyHint') : t('ask.emptyHintNoFilter') }}
              </p>
            </div>
            <!-- The number is the length of the very list rendered below it. -->
            <i18n-t
              v-else
              :keypath="countKey"
              tag="p"
              :id="outcomeId"
              :plural="results.length"
              data-test="ask-count"
              class="font-semibold text-fg"
            >
              <template #count
                ><span class="font-numeric">{{ results.length }}</span></template
              >
            </i18n-t>

            <!-- The catalog's own note, text only: an answer carries no price-run time to age. -->
            <CatalogIndexNote v-if="answer.indexedOnly" now="" />
          </div>
        </GegeSpeech>

        <!-- One row per game and every row in the document: nothing is paged, folded or left to
             load later, so the count above is what the visitor finds by scrolling. -->
        <ul v-if="results.length" class="mt-4 space-y-3">
          <li v-for="(item, index) in results" :key="item.card.id" data-test="ask-item">
            <AskResultRow :item="item" :eager="index < EAGER_COVERS" />
          </li>
        </ul>
      </template>
    </section>
  </div>
</template>

<style scoped>
/* The box around the field draws the focus ring (see the template). Written here rather than as a
   utility: the global `:focus-visible` rule in main.css is unlayered and outranks every utility. */
.ask-field:focus-visible {
  outline: none;
}
</style>
