---
title: Privacy & Security
description: "Choose what you share: account-free reading, optional email, and Zcash privacy."
---

# Privacy & Security

Your personal information belongs to you. **We will never sell your personal data.** Choose what you share, read public pages without an account, and keep private details out of public posts.

<script setup>
const topics = [
  {
    title: 'For Anons',
    description: 'Browse, watch open lives, and send Zcash support without an account.',
    href: '/privacy/for-anons',
    badge: 'Anons',
    icon: '🕵️',
  },
  {
    title: 'Zcash',
    description: 'Explore shielded Zcash and choose a wallet for direct support.',
    href: '/privacy/zcash',
    badge: 'ZEC',
    icon: '🛡️',
  },
  {
    title: 'Privacy Policy',
    description: 'Legal privacy policy entry point.',
    href: '/legal/privacy-policy',
    badge: 'Legal',
    icon: '📜',
  },
]
</script>

<p class="f2z-section-label">Principles</p>

## How Free2Z thinks about privacy

1. **Collect the minimum** needed to run the service
2. **We will never sell your personal data**
3. **Make public reading open** without requiring an account
4. **Let you support creators directly** with wallet-to-wallet Zcash
5. **Secure accounts** with strong password protection and optional two-step verification

## What you can do privately

| Action | Account required? |
| --- | --- |
| Browse public zPages | No |
| Join many broadcast lives | No |
| Send Zcash support | No |
| Comment / boost / subscribe | Yes |
| Publish | Yes |

<p class="f2z-section-label">Dive deeper</p>

## Topics

<F2zCardGrid :columns="3">
  <F2zCard
    v-for="item in topics"
    :key="item.href"
    :title="item.title"
    :description="item.description"
    :href="item.href"
    :badge="item.badge"
    :icon="item.icon"
  />
</F2zCardGrid>

## External embeds

Some pages include media from other sites. Loading those can share some browser information with that site. Free2Z can ask before loading outside content — you choose when to trust a domain.

<F2zCta
  title="Prefer to stay anon?"
  description="You can read public content and send Zcash without creating an account; shielded privacy depends on the wallet and address type."
  primary-text="For Anons"
  primary-href="/privacy/for-anons"
  secondary-text="Zcash support guide"
  secondary-href="/guides/support/donate-zcash"
/>
