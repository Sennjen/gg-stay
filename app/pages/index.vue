<script setup lang="ts">
import { LandingDocument } from '~/graphql/__generated__/operations'

const { t } = useI18n()
// A failed landing query must not surface an error box on the landing page — the hero still
// renders with the headline and call to action over the plain `ink` background, just without a
// featured game. `errorCode`/`status` are intentionally unused here (not logged, not shown).
const { data } = await useGql(LandingDocument, {})

const featured = computed(() => data.value?.landing?.featured ?? null)

useSeoMeta({ title: () => t('home.title'), description: () => t('home.description') })

// Full-bleed breakout: the layout's container (app/layouts/default.vue) centers content at
// `max-w-6xl` with side and top padding, which is right for every other page but would clip the
// hero to that width. The layout is shared with other routes and out of scope for this PR, so the
// horizontal breakout is done here instead: standard "full-bleed" CSS (viewport-relative offsets,
// not the parent's).
//
// The hero must also run UNDERNEATH the sticky transparent header, not start below it.
// `AppHeader` is `position: sticky`, so at the top of the page it still occupies its normal flow
// height (`--header-h`, see app/assets/css/main.css) above the layout's container, which itself
// adds `py-6` (1.5rem) of top padding before this page's content starts. Pulling this wrapper up
// by exactly that combined space (`calc(var(--header-h) + 1.5rem)`) moves the hero's top edge to
// the very top of the document, so the header — transparent on this route — sits over the poster
// instead of above an empty `ink` bar. No JS measurement: both amounts are fixed, known at CSS
// time, and identical on server and client.
</script>

<template>
  <main
    class="relative left-1/2 right-1/2 -mt-[calc(var(--header-h)+1.5rem)] w-screen -ml-[50vw] -mr-[50vw]"
  >
    <HeroFeatured :featured="featured" />
  </main>
</template>
