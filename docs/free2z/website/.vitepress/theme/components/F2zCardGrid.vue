<script setup lang="ts">
withDefaults(
  defineProps<{
    columns?: 2 | 3 | 4
  }>(),
  { columns: 3 },
)
</script>

<template>
  <div class="f2z-card-grid" :data-cols="columns">
    <slot />
  </div>
</template>
