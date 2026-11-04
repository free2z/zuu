<script setup lang="ts">
export interface LinkRowItem {
  title: string
  description?: string
  href: string
  meta?: string
}

defineProps<{
  items: LinkRowItem[]
}>()
</script>

<template>
  <div class="f2z-link-row">
    <a
      v-for="item in items"
      :key="item.href"
      class="f2z-link-row__item"
      :href="item.href"
    >
      <div class="f2z-link-row__main">
        <span class="f2z-link-row__title">{{ item.title }}</span>
        <span v-if="item.description" class="f2z-link-row__desc">{{ item.description }}</span>
      </div>
      <span v-if="item.meta" class="f2z-link-row__meta">{{ item.meta }}</span>
      <span class="f2z-link-row__arrow" aria-hidden="true">→</span>
    </a>
  </div>
</template>
