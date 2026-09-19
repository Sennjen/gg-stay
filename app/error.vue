<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{ error: NuxtError }>()
const { t } = useI18n()
const localePath = useLocalePath()
const isNotFound = computed(() => props.error.statusCode === 404)

useHead({ meta: [{ name: 'robots', content: 'noindex' }] })
useSeoMeta({ title: () => (isNotFound.value ? t('notFound.title') : t('errors.UPSTREAM_ERROR')) })
</script>

<template>
  <NuxtLayout>
    <div class="py-16 text-center">
      <h1 class="font-display-heading text-3xl text-fg">
        {{ isNotFound ? t('notFound.title') : t('errors.UPSTREAM_ERROR') }}
      </h1>
      <p v-if="isNotFound" class="mt-3 text-fg-2">{{ t('notFound.hint') }}</p>
      <button
        type="button"
        class="mt-8 rounded-chip bg-accent px-5 py-3 text-on-accent focus-visible:outline-2"
        @click="clearError({ redirect: localePath('/games') })"
      >
        {{ t('notFound.toCatalog') }}
      </button>
    </div>
  </NuxtLayout>
</template>
