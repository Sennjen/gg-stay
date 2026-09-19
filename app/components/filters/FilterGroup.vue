<script setup lang="ts">
defineProps<{ legend: string }>()
</script>

<template>
  <fieldset class="border-t border-slate-200 py-4">
    <legend class="pr-2 text-sm font-semibold">{{ legend }}</legend>
    <div class="mt-2 space-y-1.5">
      <slot />
    </div>
  </fieldset>
</template>
