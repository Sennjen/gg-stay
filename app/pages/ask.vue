<script setup lang="ts">
import { CatalogTaxonomiesDocument } from '~/graphql/__generated__/operations'
import { ASK_MAX_LENGTH, askCatalogQuery, normaliseAskQuery } from '~/utils/askAnswer'
import { ASK_CARD_IMAGE_SIZES } from '~/utils/rawgImage'
import { OG_IMAGE, askRobots, trimDescription, withSiteName } from '~/utils/seo'

/** How much of the question a page title may carry before it is cut on a word boundary. */
const TITLE_QUERY_LIMIT = 60

/** The three example questions, in the order the page offers them. */
const EXAMPLE_KEYS = ['coop', 'horror', 'hades'] as const

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
const catalogLink = computed(() =>
  answer.value
    ? {
        path: localePath('/games'),
        query: askCatalogQuery(answer.value.catalogUrl, answer.value.filter),
      }
    : null,
)
const itemCount = computed(() => answer.value?.items.length ?? 0)
const countKey = computed(() => (isFallback.value ? 'ask.found' : 'ask.picked'))

/**
 * What the live region says. It follows the state rather than being set by the submit handler,
 * so the server and the hydrated client agree on it; the visitor hears it change when a question
 * they sent comes back. Failures are not repeated here: their own block is `role="alert"`.
 */
const liveMessage = computed(() => {
  switch (view.value) {
    case 'loading':
      return t('ask.loading')
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
const fieldRef = ref<HTMLTextAreaElement | null>(null)
const resultsHeadingRef = ref<HTMLHeadingElement | null>(null)
const emptyQuestion = ref(false)
const describedBy = computed(() =>
  [counterId, emptyQuestion.value ? emptyQuestionId : null, privacyId].filter(Boolean).join(' '),
)

// Set by a submit, cleared once the answer it asked for has landed and focus has moved to it. A
// first load from a shared URL never moves focus: the visitor did not just ask anything.
const focusResultsWhenReady = ref(false)
watch(view, async (next) => {
  if (!focusResultsWhenReady.value || next === 'loading' || next === 'idle') return
  focusResultsWhenReady.value = false
  await nextTick()
  resultsHeadingRef.value?.focus()
})

async function submit(text: string = draft.value) {
  const question = text.trim()
  if (!question) {
    emptyQuestion.value = true
    fieldRef.value?.focus()
    return
  }
  emptyQuestion.value = false
  draft.value = question
  focusResultsWhenReady.value = true
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
  <div>
    <div class="max-w-3xl">
      <h1 class="font-display-heading text-2xl text-fg sm:text-3xl">{{ t('ask.title') }}</h1>
      <p class="mt-2 text-fg-2">{{ t('ask.lead') }}</p>

      <form role="search" class="mt-6" novalidate @submit.prevent="submit()">
        <label :for="fieldId" class="block text-sm font-medium text-fg">{{ t('ask.label') }}</label>
        <textarea
          :id="fieldId"
          ref="fieldRef"
          v-model="draft"
          name="q"
          rows="3"
          :maxlength="ASK_MAX_LENGTH"
          :aria-describedby="describedBy"
          :aria-invalid="emptyQuestion ? 'true' : undefined"
          class="mt-2 block w-full resize-y rounded-card border border-line bg-surface-1 px-4 py-3 text-base text-fg focus-visible:outline-2"
          @input="onInput"
          @keydown.enter="onEnter"
        />
        <p
          v-if="emptyQuestion"
          :id="emptyQuestionId"
          data-test="ask-empty-question"
          class="mt-2 text-sm text-fg"
        >
          {{ t('ask.emptyQuestion') }}
        </p>
        <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
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
            class="rounded-chip bg-accent px-5 py-2 font-medium text-on-accent focus-visible:outline-2"
          >
            {{ t('ask.submit') }}
          </button>
        </div>
      </form>

      <div data-test="ask-examples" class="mt-6">
        <p :id="`${fieldId}-examples`" class="text-sm text-fg-2">{{ t('ask.examplesLabel') }}</p>
        <ul :aria-labelledby="`${fieldId}-examples`" class="mt-2 flex flex-wrap gap-2">
          <li v-for="key in EXAMPLE_KEYS" :key="key">
            <button
              type="button"
              class="rounded-chip border border-line bg-surface-1 px-3 py-1.5 text-left text-sm text-fg transition-colors duration-150 ease-out hover:border-fg-2 focus-visible:outline-2"
              @click="submit(t(`ask.examples.${key}`))"
            >
              {{ t(`ask.examples.${key}`) }}
            </button>
          </li>
        </ul>
      </div>

      <p :id="privacyId" class="mt-6 text-sm text-fg-2">{{ t('ask.privacy') }}</p>
    </div>

    <p data-test="ask-live" role="status" class="sr-only">{{ liveMessage }}</p>

    <section
      v-if="view !== 'idle'"
      data-test="ask-results"
      class="mt-10"
      :aria-labelledby="resultsHeadingId"
      :aria-busy="view === 'loading' ? 'true' : undefined"
    >
      <h2
        :id="resultsHeadingId"
        ref="resultsHeadingRef"
        tabindex="-1"
        class="font-display-heading text-xl text-fg focus-visible:outline-2"
      >
        {{ t('ask.results') }}
      </h2>

      <div v-if="view === 'loading'" data-test="ask-loading" class="mt-4">
        <div class="h-5 w-2/3 max-w-md rounded bg-surface-2 motion-safe:animate-pulse" />
        <div class="mt-3 flex gap-2">
          <div class="h-7 w-28 rounded-chip bg-surface-2 motion-safe:animate-pulse" />
          <div class="h-7 w-36 rounded-chip bg-surface-2 motion-safe:animate-pulse" />
        </div>
        <ul class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <li
            v-for="index in 3"
            :key="index"
            data-test="skeleton"
            class="overflow-hidden rounded-card border border-line bg-surface-1"
          >
            <div class="aspect-video w-full bg-surface-2 motion-safe:animate-pulse" />
            <div class="space-y-2 p-3">
              <div class="h-4 w-3/4 rounded bg-surface-2 motion-safe:animate-pulse" />
              <div class="h-3 w-1/3 rounded bg-surface-2 motion-safe:animate-pulse" />
            </div>
          </li>
        </ul>
      </div>

      <div
        v-else-if="view === 'error' && failure"
        data-test="ask-error"
        role="alert"
        class="mt-4 rounded-card border border-line bg-surface-1 p-6 text-fg"
      >
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
          class="mt-4 rounded-chip bg-accent px-4 py-2 text-on-accent focus-visible:outline-2"
          @click="submit(urlQuery)"
        >
          {{ t('errors.retry') }}
        </button>
      </div>

      <template v-else-if="answer">
        <p
          v-if="isFallback"
          data-test="ask-fallback-note"
          class="mt-4 rounded-card border border-line bg-surface-1 px-4 py-3 text-sm text-fg"
        >
          {{ t('ask.fallbackNote') }}
        </p>
        <p v-else-if="answer.interpretation" data-test="ask-interpretation" class="mt-4 text-fg">
          <span class="text-fg-2">{{ t('ask.interpretation') }}</span>
          {{ ' ' }}<span class="text-lg">{{ answer.interpretation }}</span>
        </p>

        <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <ReadonlyFilterChips
            data-test="ask-filter"
            :filter="answer.filter"
            :genres="genres"
            :label="isFallback ? t('ask.searchLabel') : t('ask.filterLabel')"
          />
          <!-- A plain underlined link, not a chip: next to the chips it must not read as one more
               filter value. -->
          <NuxtLink
            v-if="catalogLink"
            :to="catalogLink"
            data-test="ask-catalog-link"
            class="text-sm text-fg underline underline-offset-4 hover:text-fg-2 focus-visible:outline-2"
          >
            {{ t('ask.openInCatalog') }}
          </NuxtLink>
        </div>

        <div
          v-if="view === 'empty'"
          data-test="ask-empty"
          class="mt-6 rounded-card border border-dashed border-line p-8 text-center"
        >
          <p class="font-semibold text-fg">{{ t('ask.emptyTitle') }}</p>
          <p class="mt-2 text-fg-2">{{ t('ask.emptyHint') }}</p>
        </div>

        <template v-else>
          <i18n-t
            :keypath="countKey"
            tag="p"
            :plural="itemCount"
            data-test="ask-count"
            class="mt-6 text-sm text-fg-2"
          >
            <template #count
              ><span class="font-numeric">{{ itemCount }}</span></template
            >
          </i18n-t>
          <!-- Each item spans two rows of the list's own grid (a subgrid): the cards of a row share
               one height and the reasons under them start on one line, however long the
               reasons or however full the cards' price lines are. -->
          <ul class="mt-3 grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
            <li
              v-for="(item, index) in answer.items"
              :key="item.card.id"
              data-test="ask-item"
              class="row-span-2 grid grid-rows-subgrid gap-y-2"
            >
              <GameCard
                :game="item.card"
                :heading-level="3"
                :cover-sizes="ASK_CARD_IMAGE_SIZES"
                :eager="index === 0"
                :priority="index === 0"
              />
              <p v-if="item.reason" data-test="ask-reason" class="px-1 text-sm text-fg">
                <span class="text-fg-2">{{ t('ask.reason') }}</span> {{ item.reason }}
              </p>
            </li>
          </ul>
        </template>
      </template>
    </section>
  </div>
</template>
