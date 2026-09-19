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
// hero to that width and push it below the transparent header. The layout is shared with other
// routes and out of scope for this PR, so the breakout is done here instead: standard
// "full-bleed" CSS (viewport-relative offsets, not the parent's), plus a negative top margin
// matching the layout's `py-6` so the hero sits flush under the sticky header.
</script>

<template>
  <div class="relative left-1/2 right-1/2 -mt-6 w-screen -ml-[50vw] -mr-[50vw]">
    <HeroFeatured :featured="featured" />
  </div>
</template>
