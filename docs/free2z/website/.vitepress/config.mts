import { defineConfig } from 'vitepress'

// Free2Z docs — brand tokens mirror ts/svelte/free2z/src/styles/globals.css
export default defineConfig({
  title: 'Free2Z Docs',
  description:
    'Discover Free2Z: publish, connect, stream, and build. Learn about Tuzis and creator earnings.',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  appearance: 'dark',
  srcExclude: ['README.md'],
  ignoreDeadLinks: [/^https?:\/\/localhost/],

  head: [
    ['link', { rel: 'icon', href: '/logo.svg', type: 'image/svg+xml' }],
    ['link', { rel: 'apple-touch-icon', href: '/logo512.png' }],
    ['meta', { name: 'theme-color', content: '#0a0a0c' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Free2Z Docs' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'Read. Publish. Get discovered. Docs for the Free2Z creator platform.',
      },
    ],
    ['meta', { property: 'og:image', content: '/logo512.png' }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
  ],

  themeConfig: {
    // Wordmark only — no circular logo icon (matches the Svelte navbar)
    siteTitle: 'Free2Z',

    nav: [
      { text: 'Discover Free2Z', link: '/overview/', activeMatch: '/overview/' },
      { text: 'What is 2Z?', link: '/getting-started/tuzis' },
      { text: 'Earn', link: '/revenue-sharing/' },
      { text: 'Features', link: '/features/' },
      { text: 'SDK', link: '/for-creators/sdk-applications' },
      { text: 'Open app', link: 'https://free2z.com' },
    ],

    sidebar: [
      {
        text: 'Discover Free2Z',
        items: [
          { text: 'A place for your ideas', link: '/overview/' },
          { text: 'Free to be you', link: '/overview/core-values' },
          { text: 'Why Free2Z?', link: '/overview/why-choose-free2z' },
        ],
      },
      {
        text: 'What is 2Z?',
        items: [
          { text: 'Meet Tuzis', link: '/getting-started/tuzis' },
          { text: 'Buy credits', link: '/guides/money/buy-2z' },
          { text: 'Use and share', link: '/for-supporters/' },
          { text: 'Direct Zcash support', link: '/privacy/zcash' },
        ],
      },
      {
        text: 'Earn',
        items: [
          { text: 'Creator earnings', link: '/revenue-sharing/' },
          { text: 'Apply and get ready', link: '/revenue-sharing/#set-up-your-creator-details' },
          { text: 'Credits & earnings', link: '/guides/money/billing' },
        ],
      },
      {
        text: 'Features',
        items: [
          { text: 'Make something yours', link: '/features/' },
          { text: 'zPages and translation', link: '/features/publishing' },
          { text: 'Converse', link: '/features/converse' },
          { text: 'Livestreams', link: '/features/live' },
          { text: 'AI and SDK apps', link: '/for-creators/sdk-applications' },
        ],
      },
      {
        text: 'Help and policies',
        collapsed: true,
        items: [
          { text: 'Quick start', link: '/getting-started/quickstart' },
          { text: 'Practical guides', link: '/guides/' },
          { text: 'Privacy', link: '/privacy/' },
          { text: 'Terms and policies', link: '/legal/' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/free2z' },
      { icon: 'x', link: 'https://twitter.com/free2zcash' },
    ],

    footer: {
      message: 'Publish. Build. Use and share.',
      copyright: `Copyright © ${new Date().getFullYear()} 2Z Inc.`,
    },

    search: {
      provider: 'local',
      options: {
        detailedView: true,
        translations: {
          button: {
            buttonText: 'Search docs',
            buttonAriaLabel: 'Search documentation',
          },
          modal: {
            displayDetails: 'Show detailed list',
            resetButtonTitle: 'Reset search',
            backButtonTitle: 'Close search',
            noResultsText: 'No results for',
            footer: {
              selectText: 'to select',
              navigateText: 'to navigate',
              closeText: 'to close',
            },
          },
        },
      },
    },

    editLink: {
      pattern: 'https://github.com/free2z/zuu/edit/main/docs/free2z/website/:path',
      text: 'Edit this page',
    },

    outline: {
      level: [2, 3],
      label: 'On this page',
    },

    docFooter: {
      prev: 'Previous',
      next: 'Next',
    },

    returnToTopLabel: 'Back to top',
    sidebarMenuLabel: 'Menu',
    darkModeSwitchLabel: 'Appearance',
    lightModeSwitchTitle: 'Switch to light',
    darkModeSwitchTitle: 'Switch to dark',
  },

  markdown: {
    theme: {
      light: 'github-light',
      dark: 'github-dark',
    },
    lineNumbers: false,
  },

  vite: {
    server: {
      port: 5174,
    },
  },
})
