<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string
    href: string
    description?: string
    badge?: string
    icon?: string
    external?: boolean
  }>(),
  {
    description: '',
    badge: '',
    icon: '',
    external: false,
  },
)
</script>

<template>
  <a
    class="f2z-nav-card"
    :href="href"
    :target="external ? '_blank' : undefined"
    :rel="external ? 'noreferrer' : undefined"
  >
    <div class="f2z-nav-card__top">
      <span v-if="icon" class="f2z-nav-card__icon" aria-hidden="true">{{ icon }}</span>
      <span v-if="badge" class="f2z-nav-card__badge">{{ badge }}</span>
    </div>
    <h3 class="f2z-nav-card__title">
      {{ title }}
      <span class="f2z-nav-card__arrow" aria-hidden="true">→</span>
    </h3>
    <p v-if="description" class="f2z-nav-card__desc">{{ description }}</p>
  </a>
</template>
