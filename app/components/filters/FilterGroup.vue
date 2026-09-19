<script setup lang="ts">
defineProps<{ legend: string }>()
</script>

<template>
  <fieldset class="border-t border-line py-4">
    <legend class="pr-2 text-sm font-semibold text-fg">{{ legend }}</legend>
    <div class="mt-2 space-y-1.5">
      <slot />
    </div>
  </fieldset>
</template>
