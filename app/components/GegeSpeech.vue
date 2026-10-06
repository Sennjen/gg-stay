<script setup lang="ts">
/**
 * Gege with a speech bubble, in the page's own flow: he stands on the left and the bubble's tail
 * points at him. The bubble is the one `GegeGreeter` draws on the landing page — `surface-2`, a
 * 1 px accent border, the card radius — so the two pages show one character.
 *
 * `lead` is the page's opening line: a large Gege, level with the middle of the bubble; on a
 * phone he stands above it, because beside him the bubble would be too narrow for a heading.
 * `reply` is a line in a conversation: a small Gege at the bubble's top corner — `size` wide, and
 * 40 px on a phone, where every pixel of width he takes is taken from the bubble.
 *
 * He is decorative, as everywhere: whatever the bubble says is in the slot, as ordinary content.
 */
import type { GegeMood } from './GegeMascot.vue'

withDefaults(
  defineProps<{
    mood?: GegeMood
    variant?: 'lead' | 'reply'
    /** His width in CSS pixels; a multiple of 20 keeps every cell a whole pixel. */
    size?: number
  }>(),
  { mood: 'idle', variant: 'reply', size: 60 },
)
</script>

<template>
  <div class="gege-speech" :class="`gege-speech--${variant}`" data-test="gege-speech">
    <!-- A wrapper, never the mascot's root, takes the layout: the root owns its transform. -->
    <span class="gege-speech__mascot">
      <GegeMascot :mood="mood" :size="size" />
    </span>
    <div
      class="gege-speech__bubble relative min-w-0 rounded-card border border-accent bg-surface-2 text-fg"
    >
      <slot />
      <!-- The bubble's tail: a square turned on its corner, pointing at him. -->
      <span aria-hidden="true" class="gege-speech__tail border-accent bg-surface-2" />
    </div>
  </div>
</template>

<style scoped>
.gege-speech {
  display: flex;
  gap: 14px;
}

.gege-speech__mascot {
  display: block;
  flex: none;
  line-height: 0;
}

.gege-speech__bubble {
  flex: 1 1 0;
}

.gege-speech__tail {
  position: absolute;
  left: -6.5px;
  width: 12px;
  height: 12px;
  border-bottom-width: 1px;
  border-left-width: 1px;
  transform: rotate(45deg);
}

/* A reply: he is at the top corner, and the tail is level with his eyes whatever his size. */
.gege-speech--reply {
  align-items: flex-start;
}

.gege-speech--reply .gege-speech__mascot {
  margin-top: 4px;
}

.gege-speech--reply .gege-speech__tail {
  top: 14px;
}

/* The mascot's width and height are attributes, so a rule can resize him without a script having
   to know the viewport — which the server render never does. 40 × 26 is two pixels to a cell. */
@media (max-width: 639px) {
  .gege-speech--reply .gege-speech__mascot :deep(svg) {
    width: 40px;
    height: 26px;
  }

  .gege-speech--reply {
    gap: 12px;
  }
}

/* The opening line on a phone: he stands on the bubble, and the tail points up at him. */
.gege-speech--lead {
  flex-direction: column;
  align-items: flex-start;
}

.gege-speech--lead .gege-speech__mascot {
  margin-left: 20px;
}

.gege-speech--lead .gege-speech__bubble {
  flex: none;
  align-self: stretch;
}

.gege-speech--lead .gege-speech__tail {
  top: -6.5px;
  left: 64px;
  border-top-width: 1px;
  border-bottom-width: 0;
}

/* From Tailwind's `sm` up he stands beside it, level with its middle. */
@media (min-width: 640px) {
  .gege-speech--lead {
    flex-direction: row;
    align-items: center;
    gap: 20px;
  }

  .gege-speech--lead .gege-speech__mascot {
    margin-left: 0;
  }

  .gege-speech--lead .gege-speech__bubble {
    flex: 1 1 0;
    align-self: auto;
  }

  .gege-speech--lead .gege-speech__tail {
    top: calc(50% - 6px);
    left: -6.5px;
    border-top-width: 0;
    border-bottom-width: 1px;
  }
}
</style>
