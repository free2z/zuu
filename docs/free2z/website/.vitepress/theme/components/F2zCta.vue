<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string
    description?: string
    primaryText?: string
    primaryHref?: string
    secondaryText?: string
    secondaryHref?: string
  }>(),
  {
    description: '',
    primaryText: '',
    primaryHref: '',
    secondaryText: '',
    secondaryHref: '',
  },
)
</script>

<template>
  <section class="f2z-cta">
    <div class="f2z-cta__glow" aria-hidden="true" />
    <div class="f2z-cta__grid" aria-hidden="true" />
    <div class="f2z-cta__body">
      <h2 class="f2z-cta__title">{{ title }}</h2>
      <p v-if="description" class="f2z-cta__desc">{{ description }}</p>
      <div v-if="primaryHref || secondaryHref" class="f2z-cta__actions">
        <a v-if="primaryHref" class="f2z-btn f2z-btn--primary" :href="primaryHref">
          {{ primaryText }}
        </a>
        <a v-if="secondaryHref" class="f2z-btn f2z-btn--ghost" :href="secondaryHref">
          {{ secondaryText }}
        </a>
      </div>
    </div>
  </section>
</template>
