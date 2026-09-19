<script setup lang="ts">
defineProps<{ name: string; coverUrl: string | null }>()
</script>

<template>
  <div class="relative left-1/2 w-screen -ml-[50vw]">
    <div class="relative flex min-h-[40vh] items-end overflow-hidden bg-surface-1 sm:min-h-[56vh]">
      <NuxtImg
        v-if="coverUrl"
        :src="coverUrl"
        :alt="name"
        width="1920"
        height="1080"
        sizes="100vw"
        loading="eager"
        fetchpriority="high"
        class="absolute inset-0 h-full w-full object-cover"
      />
      <!-- Bottom-to-top and left-to-right gradients keep the title readable over any cover. -->
      <div class="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink to-transparent" />
      <div
        class="pointer-events-none absolute inset-0 bg-gradient-to-r from-ink/70 via-transparent to-transparent"
      />
      <div class="relative z-10 mx-auto w-full max-w-6xl px-4 pb-8 pt-24 sm:pb-12">
        <h1 class="font-display-heading text-4xl text-fg sm:text-6xl">{{ name }}</h1>
        <slot />
      </div>
    </div>
  </div>
</template>
