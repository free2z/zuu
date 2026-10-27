<script setup lang="ts">
export interface PathItem {
  title: string
  description: string
  href: string
  badge?: string
  icon?: string
}

defineProps<{
  items: PathItem[]
}>()
</script>

<template>
  <div class="f2z-path">
    <a
      v-for="item in items"
      :key="item.href"
      class="f2z-path__item"
      :href="item.href"
    >
      <div class="f2z-path__icon" aria-hidden="true">{{ item.icon || '→' }}</div>
      <div class="f2z-path__content">
        <div class="f2z-path__meta">
          <span v-if="item.badge" class="f2z-path__badge">{{ item.badge }}</span>
          <h3 class="f2z-path__title">{{ item.title }}</h3>
        </div>
        <p class="f2z-path__desc">{{ item.description }}</p>
      </div>
      <span class="f2z-path__chevron" aria-hidden="true">→</span>
    </a>
  </div>
</template>
