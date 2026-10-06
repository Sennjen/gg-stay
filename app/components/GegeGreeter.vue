<script setup lang="ts">
/**
 * Gege's greeting on the landing page: two seconds after the page is interactive and the tab is
 * on screen he rises out of the bottom-right corner with a speech bubble — the deal of the day
 * when there is one, and an invitation to let him pick more games.
 *
 * The page mounts this component on the client only, after the browser has gone idle (see
 * `pages/index.vue`), so none of it is in the server HTML and nothing here runs before hydration.
 * Everything is `position: fixed` and teleported to `<body>`: no layout shifts, and the region is
 * a top-level landmark after the page's content rather than one nested in `<main>`.
 *
 * Gege himself is the toggle. Dismissed — «Не зараз», Escape, the close control or a click on
 * him — he dives back under the corner and leaves one grip sticking out as a small button that
 * opens the bubble again. A dismissal is remembered for the browser session; after it he never
 * rises by himself.
 */
import { DealOfTheDayDocument } from '~/graphql/__generated__/operations'
import type { DealOfTheDayQuery } from '~/graphql/__generated__/operations'

/** How long the tab has to stay visible, in one stretch, before he rises. */
const RISE_DELAY_MS = 2000

/**
 * How much longer he waits for a slow deal answer once the delay has passed. The bubble's copy is
 * fixed when it opens — text that arrived later would grow the bubble under the reader — so a
 * deal that is not there by then is left out of this greeting.
 */
const DEAL_GRACE_MS = 3000

const DISMISSED_KEY = 'gege:greeter:dismissed'

/** Below Tailwind's `sm` the bubble sits above him instead of beside him, and he is smaller. */
const PHONE_QUERY = '(max-width: 639px)'

/** Multiples of the mascot's 20-cell grid, so every cell is a whole number of pixels. */
const SIZE_PHONE = 80
const SIZE_DESKTOP = 120

type Deal = NonNullable<DealOfTheDayQuery['dealOfTheDay']>
type PricedDeal = Deal & { price: NonNullable<Deal['price']> }

const { t } = useI18n()
const { formatUah } = useFormatters()
const localePath = useLocalePath()
const bubbleId = useId()

/** `waiting` renders nothing at all; `open` is Gege with his bubble; `grip` is the small button. */
const phase = ref<'waiting' | 'open' | 'grip'>('waiting')
/** Set only when he came up by himself: a visitor who dismissed him earlier gets no entrance. */
const rose = ref(false)
const isPhone = ref(false)

const deal = shallowRef<PricedDeal | null>(null)
/** The deal the open bubble states: a copy taken when the bubble opens, never changed under it. */
const shownDeal = shallowRef<PricedDeal | null>(null)
const delayPassed = ref(false)
const dealSettled = ref(false)

const toggleRef = ref<HTMLButtonElement>()
const bubbleRef = ref<HTMLElement>()

let riseTimer: ReturnType<typeof setTimeout> | null = null
let graceTimer: ReturnType<typeof setTimeout> | null = null
let phoneMedia: MediaQueryList | null = null

const isOpen = computed(() => phase.value === 'open')
const mascotSize = computed(() => (isPhone.value ? SIZE_PHONE : SIZE_DESKTOP))

/** A deal is a price claim: without a discounted price to state there is nothing to announce. */
function asPricedDeal(candidate: Deal | null | undefined): PricedDeal | null {
  const price = candidate?.price
  if (!candidate || !price || price.discountPercent <= 0 || price.bestUah <= 0) return null
  return { ...candidate, price }
}

// One request per page view, made from the browser only. A failed or empty answer is simply a
// greeting without a deal.
if (import.meta.client) {
  useGql(DealOfTheDayDocument, {})
    .then(({ data }) => {
      deal.value = asPricedDeal(data.value?.dealOfTheDay)
    })
    .catch(() => {
      deal.value = null
    })
    .finally(() => {
      dealSettled.value = true
      riseWhenReady()
    })
}

// Storage can be missing or refuse access (blocked site data, some private windows). Without it
// he behaves as on a first visit, which is the right failure: a greeting, not an error.
function wasDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

function rememberDismissed() {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, '1')
  } catch {
    // Nothing to remember it in; he will greet again on the next visit.
  }
}

function clearTimers() {
  if (riseTimer !== null) clearTimeout(riseTimer)
  if (graceTimer !== null) clearTimeout(graceTimer)
  riseTimer = null
  graceTimer = null
}

/** Starts the two seconds over whenever the tab comes back; a hidden tab counts nothing. */
function armRiseTimer() {
  if (riseTimer !== null) clearTimeout(riseTimer)
  riseTimer = null
  if (document.visibilityState !== 'visible') return
  riseTimer = setTimeout(() => {
    riseTimer = null
    delayPassed.value = true
    if (!dealSettled.value) {
      graceTimer = setTimeout(() => {
        graceTimer = null
        dealSettled.value = true
        riseWhenReady()
      }, DEAL_GRACE_MS)
    }
    riseWhenReady()
  }, RISE_DELAY_MS)
}

function riseWhenReady() {
  if (phase.value !== 'waiting' || !delayPassed.value || !dealSettled.value) return
  // He rises in front of the visitor, not behind a hidden tab; `onVisibilityChange` calls back.
  if (document.visibilityState !== 'visible') return
  rose.value = true
  open()
}

function onVisibilityChange() {
  if (phase.value !== 'waiting') return
  if (delayPassed.value) riseWhenReady()
  else armRiseTimer()
}

function open() {
  shownDeal.value = deal.value
  phase.value = 'open'
}

async function dismiss() {
  if (phase.value !== 'open') return
  // The control that had focus is about to leave the page; the grip is where the bubble went.
  const focusWasInBubble = bubbleRef.value?.contains(document.activeElement) ?? false
  phase.value = 'grip'
  rememberDismissed()
  if (focusWasInBubble) {
    await nextTick()
    toggleRef.value?.focus()
  }
}

function toggle() {
  if (isOpen.value) void dismiss()
  else open()
}

function onPhoneChange(event: MediaQueryListEvent) {
  isPhone.value = event.matches
}

onMounted(() => {
  if (typeof window.matchMedia === 'function') {
    phoneMedia = window.matchMedia(PHONE_QUERY)
    isPhone.value = phoneMedia.matches
    phoneMedia.addEventListener('change', onPhoneChange)
  }
  if (wasDismissed()) {
    phase.value = 'grip'
    return
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  armRiseTimer()
})

onBeforeUnmount(() => {
  clearTimers()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  phoneMedia?.removeEventListener('change', onPhoneChange)
})
</script>

<template>
  <Teleport to="body">
    <!-- A labelled, non-modal region: it takes no focus when it appears and announces nothing by
         itself. The box is empty and lets clicks through; only Gege and his bubble are targets. -->
    <aside
      v-if="phase !== 'waiting'"
      data-test="gege-greeter"
      :data-phase="phase"
      :aria-label="t('gege.greeter.label')"
      class="gege-greeter pointer-events-none fixed inset-x-0 bottom-0 z-30 h-0"
      :class="{ 'gege-greeter--rose': rose, 'gege-greeter--phone': isPhone }"
      @keydown.esc="dismiss"
    >
      <!-- The button's box is what stays on screen in each state: all of him while the bubble is
           open, the corner his grip sticks out of once he has dived. The sprite inside moves. -->
      <button
        ref="toggleRef"
        type="button"
        data-test="gege-toggle"
        class="gege-greeter__toggle pointer-events-auto absolute right-0 bottom-0 cursor-pointer rounded-tl-card focus-visible:outline-2"
        :aria-label="t('gege.greeter.toggle')"
        :aria-expanded="isOpen"
        :aria-controls="bubbleId"
        @click="toggle"
      >
        <span class="gege-greeter__sprite">
          <GegeMascot mood="peek" :size="mascotSize" :animated="isOpen" />
        </span>
      </button>

      <Transition name="gege-bubble">
        <div
          v-if="isOpen"
          :id="bubbleId"
          ref="bubbleRef"
          data-test="gege-bubble"
          class="gege-greeter__bubble pointer-events-auto absolute rounded-card border border-accent bg-surface-2 text-sm text-fg"
        >
          <!-- Only the copy scrolls if a small screen leaves the bubble too little room: the
               buttons, the close control and the tail stay where they are. -->
          <div class="gege-greeter__copy">
            <p class="pr-8">
              <i18n-t keypath="gege.greeter.hello" tag="span" scope="global">
                <template #name>
                  <span class="font-display-heading">{{ t('gege.name') }}</span>
                </template>
              </i18n-t>
              <template v-if="shownDeal">
                {{ ' ' }}
                <i18n-t keypath="gege.greeter.deal" tag="span" scope="global" data-test="gege-deal">
                  <template #name>
                    <NuxtLink
                      :to="localePath(`/games/${shownDeal.slug}`)"
                      class="font-semibold text-fg underline underline-offset-4 focus-visible:outline-2"
                      >{{ shownDeal.name }}</NuxtLink
                    >
                  </template>
                  <template #discount>
                    <span
                      class="font-numeric inline-flex items-center rounded-chip bg-sale px-1.5 py-0.5 text-xs font-semibold text-on-sale"
                      >−{{ shownDeal.price.discountPercent }}%</span
                    >
                  </template>
                  <template #price>
                    <span class="font-numeric font-medium whitespace-nowrap">{{
                      formatUah(shownDeal.price.bestUah)
                    }}</span>
                  </template>
                </i18n-t>
              </template>
            </p>
            <p class="mt-2 text-fg-2">{{ t('gege.greeter.pitch') }}</p>
          </div>

          <div class="gege-greeter__actions flex flex-wrap gap-2">
            <NuxtLink
              :to="localePath('/ask')"
              data-test="gege-accept"
              class="inline-flex min-h-11 items-center justify-center rounded-chip bg-accent px-5 font-medium text-on-accent focus-visible:outline-2"
            >
              {{ t('gege.greeter.accept') }}
            </NuxtLink>
            <button
              type="button"
              data-test="gege-decline"
              class="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-chip border border-line px-5 font-medium text-fg transition-colors duration-200 ease-out hover:border-fg-2 focus-visible:outline-2"
              @click="dismiss"
            >
              {{ t('gege.greeter.decline') }}
            </button>
          </div>

          <button
            type="button"
            data-test="gege-close"
            class="absolute top-0 right-0 flex h-11 w-11 cursor-pointer items-center justify-center rounded-card text-fg-2 transition-colors duration-200 ease-out hover:text-fg focus-visible:outline-2"
            :aria-label="t('gege.greeter.close')"
            @click="dismiss"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" />
            </svg>
          </button>

          <!-- The bubble's tail: a square turned on its corner, pointing at him. -->
          <span aria-hidden="true" class="gege-greeter__tail border-accent bg-surface-2" />
        </div>
      </Transition>
    </aside>
  </Teleport>
</template>

<style scoped>
/* One cell of the mascot's 20-cell grid: every offset below is counted in his own pixels. */
.gege-greeter {
  --gege-cell: 6px;
  --gege-inset: 16px;
}

.gege-greeter--phone {
  --gege-cell: 4px;
}

/* Open, the hit area is all of him that shows; dived, it is the corner around the one grip. */
.gege-greeter__toggle {
  width: calc(var(--gege-cell) * 20 + var(--gege-inset) * 2);
  height: calc(var(--gege-cell) * 12);
}

.gege-greeter[data-phase='grip'] .gege-greeter__toggle {
  width: 56px;
  height: 44px;
}

/* He peeks: the very tips of his grips stay under the edge of the screen. */
.gege-greeter__sprite {
  position: absolute;
  right: var(--gege-inset);
  bottom: calc(var(--gege-cell) * -1);
  line-height: 0;
  display: block;
  transition: transform 250ms ease-out;
}

/* Dived head first: turned upside down — a half turn keeps every pixel square — and pushed down
   and to the right until one grip is left standing in the corner. */
.gege-greeter[data-phase='grip'] .gege-greeter__sprite {
  transform: translate(calc(var(--gege-cell) * 12 + 12px), calc(var(--gege-cell) * 6))
    rotate(180deg);
}

.gege-greeter--rose .gege-greeter__sprite {
  animation: gege-greeter-rise 250ms ease-out backwards;
}

@keyframes gege-greeter-rise {
  from {
    transform: translateY(120%);
  }
}

/* Beside him on a wide screen. */
.gege-greeter__bubble {
  right: calc(var(--gege-cell) * 20 + var(--gege-inset) * 2);
  bottom: 20px;
  width: 22rem;
}

.gege-greeter__copy {
  padding: 16px 16px 0;
}

.gege-greeter__actions {
  padding: 12px 16px 16px;
}

.gege-greeter__tail {
  position: absolute;
  right: -6.5px;
  bottom: 22px;
  width: 12px;
  height: 12px;
  border-top-width: 1px;
  border-right-width: 1px;
  transform: rotate(45deg);
}

/* Above him on a phone, as wide as the screen allows, and with him never taller than the bottom
   third of the screen: past that the copy scrolls inside the bubble, above the buttons, rather
   than covering more of the page. The 68px are the row of buttons and its padding. */
.gege-greeter--phone .gege-greeter__bubble {
  right: var(--gege-inset);
  bottom: calc(var(--gege-cell) * 12 + 4px);
  left: var(--gege-inset);
  width: auto;
}

.gege-greeter--phone .gege-greeter__copy {
  max-height: calc(100vh / 3 - var(--gege-cell) * 12 - 6px - 68px);
  padding: 12px 12px 0;
  overflow-y: auto;
}

.gege-greeter--phone .gege-greeter__actions {
  padding: 12px;
}

.gege-greeter--phone .gege-greeter__tail {
  right: calc(var(--gege-cell) * 9);
  bottom: -6.5px;
  border-top-width: 0;
  border-bottom-width: 1px;
}

.gege-bubble-enter-active,
.gege-bubble-leave-active {
  transition:
    opacity 200ms ease-out,
    transform 200ms ease-out;
}

.gege-bubble-enter-from,
.gege-bubble-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

/* The global rule in main.css already shortens every duration to nothing; this removes the rise
   itself, so he is simply there. */
@media (prefers-reduced-motion: reduce) {
  .gege-greeter--rose .gege-greeter__sprite {
    animation: none;
  }
}
</style>
