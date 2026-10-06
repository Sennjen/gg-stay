<script setup lang="ts">
/**
 * Gege, the AI-picks mascot: a gamepad seen from the front, drawn as an inline SVG on a 20 × 13
 * pixel grid. Decorative — the text beside him carries the meaning, so he is hidden from
 * assistive technology and takes no focus.
 *
 * The grid is 20 wide on purpose: the header shows him 20 px wide, where one cell is exactly one
 * device-independent pixel. Any multiple of 20 stays pixel-perfect; other widths are still crisp
 * (`shape-rendering="crispEdges"`) with cells that differ by a pixel.
 *
 * A mood is a pose first and a motion second: the pose is in the markup, the motion is CSS that
 * only applies with `animated` and without `prefers-reduced-motion: reduce`. Without motion each
 * mood is still told apart by its drawing alone.
 */
export type GegeMood = 'idle' | 'peek' | 'thinking' | 'happy'

const GRID_WIDTH = 20
const GRID_HEIGHT = 13

const props = withDefaults(
  defineProps<{
    mood?: GegeMood
    /** Width in CSS pixels; the height follows the grid's ratio. */
    size?: number
    /** `false` draws the mood's static pose and nothing moves — the header's small face. */
    animated?: boolean
  }>(),
  { mood: 'idle', size: 96, animated: true },
)

const height = computed(() => Math.round((props.size * GRID_HEIGHT) / GRID_WIDTH))
</script>

<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :viewBox="`0 0 ${GRID_WIDTH} ${GRID_HEIGHT}`"
    :width="size"
    :height="height"
    shape-rendering="crispEdges"
    aria-hidden="true"
    focusable="false"
    class="gege shrink-0"
    :class="[`gege--${mood}`, { 'gege--animated': animated }]"
    :data-mood="mood"
  >
    <!-- Every path is a list of grid rectangles, each written "M x y h width v height h -width z",
         so a shape can be read and edited one pixel run at a time. -->
    <!-- Body: a rounded top, a flat belly and two grips as legs. -->
    <path
      class="fill-accent"
      d="M4 0h12v1h-12zM2 1h16v1h-16zM1 2h18v1h-18zM0 3h20v6h-20zM0 9h8v1h-8zM12 9h8v1h-8zM0 10h7v1h-7zM13 10h7v1h-7zM1 11h5v1h-5zM14 11h5v1h-5zM2 12h3v1h-3zM15 12h3v1h-3z"
    />
    <!-- One highlight along the top-left edge, one darker amber under the belly and the grips. -->
    <path class="gege-highlight" d="M5 1h5v1h-5zM2 2h2v1h-2zM1 3h1v2h-1z" />
    <path
      class="gege-shade"
      d="M8 8h4v1h-4zM7 9h1v1h-1zM12 9h1v1h-1zM6 10h1v1h-1zM13 10h1v1h-1zM2 12h3v1h-3zM15 12h3v1h-3zM5 11h1v1h-1zM18 11h1v1h-1zM19 8h1v3h-1z"
    />

    <!-- D-pad, a cross on the left. -->
    <path class="fill-ink" d="M3 4h1v3h-1zM2 5h3v1h-3z" />

    <!-- Four face buttons on the right, clockwise from the top. While he thinks they light up one
         after another; the static thinking pose keeps the first one lit. -->
    <g :class="{ 'gege-buttons--thinking': mood === 'thinking' }">
      <rect class="gege-button gege-button--1" x="16" y="4" width="1" height="1" />
      <rect class="gege-button gege-button--2" x="17" y="5" width="1" height="1" />
      <rect class="gege-button gege-button--3" x="16" y="6" width="1" height="1" />
      <rect class="gege-button gege-button--4" x="15" y="5" width="1" height="1" />
    </g>

    <!-- Eyes: open with a pupil and a glint, half-lidded while he thinks, arcs when he is happy. -->
    <path
      v-if="mood === 'happy'"
      class="fill-ink"
      data-eyes="arcs"
      d="M6 2h3v1h-3zM6 3h1v1h-1zM8 3h1v1h-1zM11 2h3v1h-3zM11 3h1v1h-1zM13 3h1v1h-1z"
    />
    <g v-else-if="mood === 'thinking'" data-eyes="narrowed">
      <path class="gege-shade" d="M6 2h3v1h-3zM11 2h3v1h-3z" />
      <path class="fill-signal" d="M6 3h3v2h-3zM11 3h3v2h-3z" />
      <path class="fill-ink" d="M7 3h2v1h-2zM12 3h2v1h-2z" />
    </g>
    <g v-else data-eyes="open">
      <path class="fill-signal" d="M6 2h3v3h-3zM11 2h3v3h-3z" />
      <path class="fill-ink" d="M7 3h2v2h-2zM12 3h2v2h-2z" />
      <path class="fill-fg" d="M6 2h1v1h-1zM11 2h1v1h-1z" />
      <!-- Closed lids, shown for a moment by the idle blink only. -->
      <g v-if="mood === 'idle'" class="gege-blink">
        <path class="fill-accent" d="M6 2h3v3h-3zM11 2h3v3h-3z" />
        <path class="fill-ink" d="M6 4h3v1h-3zM11 4h3v1h-3z" />
      </g>
    </g>

    <!-- Mouth: a small smile, a wide open one when he is happy, a flat line while he thinks. -->
    <path
      v-if="mood === 'happy'"
      class="fill-ink"
      data-mouth="happy"
      d="M8 6h4v1h-4zM9 7h2v1h-2z"
    />
    <path v-else-if="mood === 'thinking'" class="fill-ink" data-mouth="thinking" d="M9 7h2v1h-2z" />
    <path v-else class="fill-ink" data-mouth="smile" d="M8 6h1v1h-1zM9 7h2v1h-2zM11 6h1v1h-1z" />
  </svg>
</template>

<style scoped>
/* The two extra ambers are mixed from the tokens, so the drawing still holds no colour of its own. */
.gege-highlight {
  fill: color-mix(in srgb, var(--color-accent) 55%, var(--color-fg));
}

.gege-shade {
  fill: color-mix(in srgb, var(--color-accent) 72%, var(--color-ink));
}

.gege-button {
  fill: var(--color-ink);
}

.gege-buttons--thinking .gege-button--1 {
  fill: var(--color-signal);
}

.gege-blink {
  opacity: 0;
}

/* The peek pose is tilted whether or not he sways. */
.gege--peek {
  transform: rotate(-8deg);
}

.gege--animated.gege--idle {
  animation: gege-float 3.2s step-end infinite;
}

.gege--animated.gege--idle .gege-blink {
  animation: gege-blink 4.4s step-end infinite;
}

.gege--animated.gege--peek {
  animation: gege-sway 2.4s ease-in-out infinite alternate;
}

.gege--animated.gege--happy {
  animation: gege-hop 0.6s ease-out 1;
}

.gege--animated .gege-buttons--thinking .gege-button {
  animation: gege-press 1.6s step-end infinite;
}

.gege--animated .gege-buttons--thinking .gege-button--2 {
  animation-delay: 0.4s;
}

.gege--animated .gege-buttons--thinking .gege-button--3 {
  animation-delay: 0.8s;
}

.gege--animated .gege-buttons--thinking .gege-button--4 {
  animation-delay: 1.2s;
}

/* Whole pixels, held: he floats the way a sprite does, not the way a balloon does. */
@keyframes gege-float {
  0%,
  100% {
    transform: translateY(0);
  }
  25%,
  75% {
    transform: translateY(-1px);
  }
  50% {
    transform: translateY(-3px);
  }
}

@keyframes gege-blink {
  0% {
    opacity: 0;
  }
  94% {
    opacity: 1;
  }
  98% {
    opacity: 0;
  }
}

@keyframes gege-sway {
  from {
    transform: rotate(-8deg);
  }
  to {
    transform: rotate(-3deg);
  }
}

@keyframes gege-hop {
  0%,
  60%,
  100% {
    transform: translateY(0);
  }
  30% {
    transform: translateY(-6px);
  }
  80% {
    transform: translateY(-2px);
  }
}

@keyframes gege-press {
  0% {
    fill: var(--color-signal);
  }
  25%,
  100% {
    fill: var(--color-ink);
  }
}

/* Every loop stops and the mood's static pose is what is left. The global rule in main.css only
   shortens durations; this one removes the animations outright. */
@media (prefers-reduced-motion: reduce) {
  .gege,
  .gege * {
    animation: none !important;
  }
}
</style>
