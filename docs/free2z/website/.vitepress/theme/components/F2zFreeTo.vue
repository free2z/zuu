<script setup lang="ts">
import { ref } from 'vue'
const paused = ref(false)
const words = ['create', 'share', 'explore', 'be you']
</script>

<template>
  <div class="free-to" :class="{ paused }">
    <span class="free-to__accessible">Free to create, share, explore, and be you.</span>
    <div class="free-to__message" aria-hidden="true">
      <span>Free to</span>
      <span class="free-to__window">
        <span class="free-to__wheel">
          <span v-for="(word, index) in words" :key="word" class="free-to__face"
            :style="{ '--face': index }">{{ word }}</span>
        </span>
      </span>
    </div>
    <button class="free-to__control" type="button" :aria-pressed="paused"
      :aria-label="paused ? 'Play text animation' : 'Pause text animation'"
      @click="paused = !paused">{{ paused ? 'Play' : 'Pause' }}</button>
  </div>
</template>

<style scoped>
.free-to { display: flex; align-items: center; gap: 1rem; margin: 0 0 1.25rem; }
.free-to__message { display: flex; gap: .3em; align-items: center; font-size: clamp(1.4rem, 4vw, 2rem); font-weight: 750; line-height: 1.4; letter-spacing: -.035em; }
.free-to__window { display: inline-block; width: 4.2em; height: 1.4em; perspective: 12em; }
.free-to__wheel { position: relative; display: block; width: 100%; height: 100%; transform-style: preserve-3d; animation: free-to-turn 16s infinite; }
.free-to__face { position: absolute; inset: 0; display: flex; align-items: center; backface-visibility: hidden; color: var(--f2z-accent-primary); transform: rotateX(calc(var(--face) * -90deg)) translateZ(.7em); }
.free-to.paused .free-to__wheel { animation-play-state: paused; }
.free-to__control { border: 1px solid var(--f2z-border-primary); padding: .3rem .55rem; border-radius: 999px; font-size: .75rem; color: var(--f2z-text-muted); }
.free-to__control:hover { color: var(--f2z-text-primary); border-color: var(--f2z-accent-primary); }
.free-to__control:focus-visible { outline: 2px solid var(--f2z-accent-primary); outline-offset: 4px; }
.free-to__accessible { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@keyframes free-to-turn {
  0%, 20% { transform: rotateX(0deg); }
  25%, 45% { transform: rotateX(90deg); }
  50%, 70% { transform: rotateX(180deg); }
  75%, 95% { transform: rotateX(270deg); }
  100% { transform: rotateX(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .free-to__wheel { animation: none; transform: none; }
  .free-to__face { transform: none; }
  .free-to__face:not(:first-child), .free-to__control { display: none; }
}
@media (max-width: 959px) { .free-to { justify-content: center; } }
</style>
