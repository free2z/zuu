<script setup lang="ts">
withDefaults(
  defineProps<{
    tone?: 'accent' | 'muted' | 'live'
  }>(),
  { tone: 'accent' },
)
</script>

<template>
  <span class="f2z-badge" :data-tone="tone">
    <span v-if="tone === 'live'" class="f2z-badge__dot" aria-hidden="true" />
    <slot />
  </span>
</template>
