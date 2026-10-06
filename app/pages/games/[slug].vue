<script setup lang="ts">
import { GameDocument } from '~/graphql/__generated__/operations'
import { safeExternalUrl } from '#shared/url'
import { splitParagraphs } from '~/utils/format'
import { INDEXABLE, SITE_NAME, metaDescription, withSiteName } from '~/utils/seo'
import { coverShareImage, gameJsonLd, serializeJsonLd } from '~/utils/structuredData'

const route = useRoute()
const { t, locale, localeProperties } = useI18n()
const localePath = useLocalePath()
const store = useFiltersStore()

const slug = computed(() => String(route.params.slug))
const gameQuery = await useGql(GameDocument, () => ({
  slug: slug.value,
  locale: locale.value,
}))
const { data, errorCode, refresh } = gameQuery

if (errorCode.value === 'NOT_FOUND') {
  // Real HTTP 404 during SSR; renders app/error.vue, which sets noindex. Checked once, in setup:
  // a later client-side refetch that 404s (a game delisted from RAWG while the tab was open)
  // renders the generic ErrorState instead of a real 404. Acceptable — a fatal createError after
  // hydration would replace the whole app with the error page for a stale tab.
  throw createError({ statusCode: 404, statusMessage: 'Game not found', fatal: true })
}

// The server answers inside a time budget, with what it has: a `partial` game is one it had not
// finished collecting the answers about (`server/graphql/resolvers/game.ts`). The page says so in
// one line and asks again by itself, in the browser, until the answer is whole or two attempts are
// spent — the whole answer then takes the place of the partial one in one step. What that step
// may move on the page is in DESIGN.md, "A game page answered in part".
const { state: asking } = useRetryWhilePartial(gameQuery, (answer) => answer?.game?.partial)

/**
 * What the line over the cover says: that the rest is on its way while the page is asking for it,
 * that it did not come once the page has stopped asking, and nothing otherwise.
 *
 * It follows what the page is doing, not `game.partial` itself, and the page does nothing until it
 * is mounted. So a server's markup has no such sentence in it — a crawler, which takes the page as
 * the server sent it, does not read "still loading" as the page's text — and the sentence is put
 * into a status region that was already there, which is what makes a screen reader say it.
 */
const partialNote = computed(() => {
  switch (asking.value) {
    case 'asking':
      return t('game.stillLoading')
    case 'stopped':
      return t('game.notLoaded')
    default:
      return ''
  }
})

const game = computed(() => data.value?.game ?? null)
// Defence in depth: the mapper already refuses a non-http(s) `website`, but the check belongs
// next to the `:href` too — Vue does not sanitise `href`, and this value is publisher-submitted.
const website = computed(() => safeExternalUrl(game.value?.website))
const names = (list?: { name: string }[]) => (list ?? []).map((entry) => entry.name).join(', ')
const localizedDescription = computed(() => game.value?.localizedDescription ?? null)
const descriptionParagraphs = computed(() => splitParagraphs(localizedDescription.value?.text))
const isSteamDescription = computed(() => localizedDescription.value?.source === 'STEAM')

/**
 * The description in the page's own language: the text the page shows when it is in that language
 * (the Ukrainian Steam description on `/games/…`, RAWG's English one on `/en/games/…`), trimmed on
 * a word boundary; otherwise a sentence of our own in the page's language rather than RAWG's
 * English under a Ukrainian page.
 */
const description = computed(() => {
  const shown = localizedDescription.value
  const sameLanguage = shown?.language.slice(0, 2) === locale.value
  const text = sameLanguage ? metaDescription(shown?.text) : ''
  return text || t('game.metaFallback', { name: game.value?.name ?? '' })
})

// Computed once (server or first client render) and reused from then on — see the comment on
// `currentYear` in `pages/games/index.vue`, the same pattern for the same reason: the scoreboard's
// "updated N hours ago" is derived from this, and no component may call `Date.now()` in its own
// render path (server and client would then compute two different values as soon as a second
// passes between the two renders, which is the exact shape of a hydration mismatch).
const now = useState('game-page-now', () => new Date().toISOString())

const { absoluteUrl } = useSiteUrl()
const robots = useRobots()
const shareImage = computed(() => coverShareImage(game.value?.cover?.url))
const headTitle = computed(() => (game.value ? withSiteName(game.value.name) : SITE_NAME))

useSeoMeta({
  title: () => headTitle.value,
  description: () => description.value,
  robots: robots(INDEXABLE),
  ogTitle: () => game.value?.name,
  ogDescription: () => description.value,
  ogImage: () => shareImage.value?.url,
  ogImageWidth: () => shareImage.value?.width,
  ogImageHeight: () => shareImage.value?.height,
  ogImageAlt: () => game.value?.name,
})

// The page's facts as a `VideoGame`, from the same answer the page renders. Data, not code: the
// CSP plugin leaves `application/ld+json` out of its script hashes, and `serializeJsonLd` makes
// sure a game name can never end the element early.
useHead({
  script: () =>
    game.value
      ? [
          {
            key: 'ld-game',
            type: 'application/ld+json',
            innerHTML: serializeJsonLd(
              gameJsonLd(game.value, {
                url: absoluteUrl(route.path),
                title: headTitle.value,
                description: description.value,
                inLanguage: localeProperties.value.language ?? 'uk-UA',
                now: now.value,
              }),
            ),
          },
        ]
      : [],
})
</script>

<template>
  <div>
    <NuxtLink
      :to="{ path: localePath('/games'), query: store.lastCatalogQuery }"
      class="text-sm text-fg-2 underline-offset-4 hover:text-fg hover:underline focus-visible:outline-2"
    >
      {{ t('game.backToCatalog') }}
    </NuxtLink>

    <StatesErrorState v-if="errorCode" class="mt-6" :code="errorCode" @retry="refresh()" />

    <article v-else-if="game" class="relative mt-4">
      <!-- Over the top corner of the cover, out of the flow, so the page is laid out exactly as it
           is without it: nothing moves when it appears, and nothing when the whole answer takes
           it away. The status region is there on every game page, empty and with no box of its
           own, and the line is put into it: once when the page starts asking, and — with other
           words, in the same element — once more if it stops with the answer still partial. The
           attempts in between neither rebuild nor reword it, so each sentence is announced once. -->
      <div role="status" class="absolute left-0 top-3 z-20 max-w-full">
        <p
          v-if="partialNote"
          data-test="game-partial-note"
          class="rounded-card border border-line bg-ink/85 px-2.5 py-1 text-xs text-fg-2"
        >
          {{ partialNote }}
        </p>
      </div>

      <GameHero :name="game.name" :cover-url="game.cover?.url ?? null">
        <GameScoreboard :game="game" :now="now" />
      </GameHero>

      <div class="mt-8 grid gap-8 lg:grid-cols-[1fr_20rem]">
        <div>
          <section v-if="descriptionParagraphs.length">
            <div class="flex items-baseline gap-2">
              <h2 class="font-display-heading text-xl text-fg">{{ t('game.about') }}</h2>
              <span v-if="isSteamDescription" class="text-sm text-fg-2">{{
                t('game.descriptionSourceSteam')
              }}</span>
            </div>
            <div
              :lang="localizedDescription?.language"
              class="mt-2 max-w-prose space-y-4 leading-relaxed text-fg-2"
            >
              <p v-for="(paragraph, index) in descriptionParagraphs" :key="index">
                {{ paragraph }}
              </p>
            </div>
          </section>

          <ScreenshotGallery class="mt-8" :images="game.screenshots" :title="game.name" />

          <StoreLinks class="mt-8" :offers="game.stores" />
        </div>

        <dl class="h-fit space-y-3 rounded-card border border-line bg-surface-1 p-4 text-sm">
          <div v-if="game.genres.length">
            <dt class="text-fg-2">{{ t('game.genres') }}</dt>
            <dd>{{ names(game.genres) }}</dd>
          </div>
          <div v-if="game.gameModes.length">
            <dt class="text-fg-2">{{ t('game.gameModes') }}</dt>
            <dd>{{ game.gameModes.map((mode) => t(`gameModes.${mode}`)).join(', ') }}</dd>
          </div>
          <div v-if="game.ageRating">
            <dt class="text-fg-2">{{ t('game.ageRating') }}</dt>
            <dd>{{ t(`ageRatings.${game.ageRating}`) }}</dd>
          </div>
          <div v-if="game.playtime">
            <dt class="text-fg-2">{{ t('game.playtime') }}</dt>
            <dd>
              <i18n-t keypath="game.hours" tag="span">
                <template #count
                  ><span class="font-numeric">{{ game.playtime }}</span></template
                >
              </i18n-t>
            </dd>
          </div>
          <div v-if="game.developers.length">
            <dt class="text-fg-2">{{ t('game.developers') }}</dt>
            <dd>{{ names(game.developers) }}</dd>
          </div>
          <div v-if="game.publishers.length">
            <dt class="text-fg-2">{{ t('game.publishers') }}</dt>
            <dd>{{ names(game.publishers) }}</dd>
          </div>
          <div v-if="website">
            <dt class="text-fg-2">{{ t('game.website') }}</dt>
            <dd>
              <a
                :href="website"
                target="_blank"
                rel="noopener noreferrer"
                class="break-all text-fg underline underline-offset-4 hover:text-fg-2"
              >
                {{ website }}
              </a>
            </dd>
          </div>
        </dl>
      </div>

      <!-- Below the gallery and the store links, full width: the page's own content comes first.
           `GameRow` renders nothing for an empty list, which is how the answer says "hidden" —
           fewer than four similar games, or an index that could not be asked. -->
      <GameRow
        data-test="similar-games"
        class="mt-12"
        :title="t('game.similar')"
        :games="game.similar"
      />
    </article>
  </div>
</template>
