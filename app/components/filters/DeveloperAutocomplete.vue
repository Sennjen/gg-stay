<script setup lang="ts">
import { DevelopersDocument, type DevelopersQuery } from '~/graphql/__generated__/operations'
import { print } from 'graphql/language/printer'

const props = defineProps<{ modelValue: string[] }>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()
const { t } = useI18n()

const term = ref('')
const suggestions = ref<DevelopersQuery['developers']>([])
const query = print(DevelopersDocument)
let timer: ReturnType<typeof setTimeout> | undefined

// Client-only, user-triggered lookup: useAsyncData is for render-blocking data, this is not.
watch(term, (value) => {
  clearTimeout(timer)
  if (value.trim().length < 2) {
    suggestions.value = []
    return
  }
  timer = setTimeout(async () => {
    try {
      const response = await $fetch<{ data?: DevelopersQuery }>('/api/graphql', {
        method: 'POST',
        body: { query, variables: { search: value } },
      })
      suggestions.value = response.data?.developers ?? []
    } catch {
      suggestions.value = []
    }
  }, 300)
})
onBeforeUnmount(() => clearTimeout(timer))

function add(slug: string) {
  if (!props.modelValue.includes(slug)) emit('update:modelValue', [...props.modelValue, slug])
  term.value = ''
  suggestions.value = []
}
</script>

<template>
  <div>
    <ul v-if="modelValue.length" class="mb-2 flex flex-wrap gap-1.5">
      <li v-for="slug in modelValue" :key="slug">
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-chip border border-accent bg-accent px-2.5 py-1 text-xs text-on-accent focus-visible:outline-2"
          :aria-label="t('filters.remove', { name: slug })"
          @click="
            emit(
              'update:modelValue',
              modelValue.filter((entry) => entry !== slug),
            )
          "
        >
          {{ slug }} ×
        </button>
      </li>
    </ul>
    <input
      v-model="term"
      type="search"
      :placeholder="t('filters.developerPlaceholder')"
      :aria-label="t('filters.developer')"
      class="w-full rounded-card border border-line bg-surface-1 px-2 py-1 text-sm text-fg focus-visible:outline-2"
    />
    <ul v-if="suggestions.length" class="mt-1 rounded-card border border-line bg-surface-1">
      <li v-for="developer in suggestions" :key="developer.id">
        <button
          type="button"
          class="block w-full px-2 py-1 text-left text-sm text-fg hover:bg-surface-2 focus-visible:outline-2"
          @click="add(developer.slug)"
        >
          {{ developer.name }}
        </button>
      </li>
    </ul>
  </div>
</template>
