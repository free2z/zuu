---
title: Legal
description: Terms of Service and Privacy Policy for Free2Z / 2Z Inc.
---

# Legal

Formal policies for Free2Z / 2Z Inc.

::: warning
The pages in this section are provided for convenience. If there is any conflict between documentation summaries and the binding legal text hosted by Free2Z, the binding legal text controls.
:::

<script setup>
const docs = [
  {
    title: 'Terms of Service',
    description: 'Summary entry point for Free2Z terms.',
    href: '/legal/terms-of-service',
    badge: 'Terms',
    icon: '⚖️',
  },
  {
    title: 'Privacy Policy',
    description: 'How Free2Z handles personal data.',
    href: '/legal/privacy-policy',
    badge: 'Privacy',
    icon: '🔒',
  },
]
</script>

<p class="f2z-section-label">Documents</p>

## Available here

<F2zCardGrid :columns="2">
  <F2zCard
    v-for="item in docs"
    :key="item.href"
    :title="item.title"
    :description="item.description"
    :href="item.href"
    :badge="item.badge"
    :icon="item.icon"
  />
</F2zCardGrid>

## Credits and creator services

- [Usage credits and purchases](/legal/usage-credits): what credits buy, payment instructions, and delivery or refund help.
- [Creator compensation](/legal/creator-compensation): qualifying services, creator responsibilities, USD earnings, and payment terms.

These pages explain the essentials. Read the full documents linked from each page and the terms displayed in Credits & Earnings before confirming a purchase or accepting a creator agreement.

## Contact

For questions about terms, delivery, privacy, or payment, contact [help@free2z.com](mailto:help@free2z.com).
