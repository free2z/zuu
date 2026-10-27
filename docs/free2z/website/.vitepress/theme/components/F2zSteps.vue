<script setup lang="ts">
export interface StepItem {
  title: string
  description: string
  href?: string
}

defineProps<{
  steps: StepItem[]
}>()
</script>

<template>
  <ol class="f2z-steps">
    <li v-for="(step, i) in steps" :key="i" class="f2z-steps__item">
      <div class="f2z-steps__index" aria-hidden="true">{{ i + 1 }}</div>
      <div class="f2z-steps__body">
        <a v-if="step.href" class="f2z-steps__title" :href="step.href">{{ step.title }}</a>
        <span v-else class="f2z-steps__title f2z-steps__title--plain">{{ step.title }}</span>
        <p class="f2z-steps__desc">{{ step.description }}</p>
      </div>
    </li>
  </ol>
</template>
