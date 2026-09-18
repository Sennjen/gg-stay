<script setup lang="ts">
const props = withDefaults(defineProps<{ code: string; retryDelayMs?: number }>(), {
  retryDelayMs: 2000,
})
const emit = defineEmits<{ retry: [] }>()
const { t, te } = useI18n()

const isRateLimited = computed(() => props.code === 'UPSTREAM_RATE_LIMITED')
const message = computed(() =>
  te(`errors.${props.code}`) ? t(`errors.${props.code}`) : t('errors.UPSTREAM_ERROR'),
)

// One automatic retry per mount: if the retry fails too, the message stays without looping.
let timer: ReturnType<typeof setTimeout> | undefined
onMounted(() => {
  if (isRateLimited.value) timer = setTimeout(() => emit('retry'), props.retryDelayMs)
})
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div role="alert" class="rounded-lg border border-amber-300 bg-amber-50 p-6 text-center">
    <p>{{ message }}</p>
    <button
      v-if="!isRateLimited"
      type="button"
      class="mt-4 rounded bg-slate-900 px-4 py-2 text-white focus-visible:outline-2"
      @click="emit('retry')"
    >
      {{ t('errors.retry') }}
    </button>
  </div>
</template>
