// @ts-check
// Note: type annotations allow type checking and IDEs autocompletion

const lightCodeTheme = require('prism-react-renderer').themes.github;
const darkCodeTheme = require('prism-react-renderer').themes.dracula;

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Free2Z',
  // tagline: 'Support Creators.<br>Raise Money.<br>Build Community.',
  url: 'https://free2z.com',
  baseUrl: '/docs/',
  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'warn',
  favicon: '/docs/img/2Z-Logo.svg',
  // undefined by default ... c'mon root
  // trailingSlash: false,

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: '2Z Inc.', // Usually your GitHub org/user name.
  projectName: 'Free2Z', // Usually your repo name.

  // Even if you don't use internalization, you can use this field to set useful
  // metadata like html lang. For example, if your site is Chinese, you may want
  // to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: 'en',
    // TODO: es! ...
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          routeBasePath: '/',
          sidebarPath: require.resolve('./sidebars.js'),
          // Please change this to your repo.
          // Remove this to remove the "edit this page" links.
          editUrl:
            'https://github.com/free2z/zuu/main/docs/',
        },
        blog: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: {
        defaultMode: 'dark',
        disableSwitch: false,
        respectPrefersColorScheme: false,
      },
      // TODO: doesn't point to relative so points at only prod for
      // some reason ..
      image: 'img/2Z-Logo.svg',
      navbar: {
        title: 'Free2Z',
        logo: {
          alt: 'Free2z',
          src: '/docs/img/2Z-Logo.svg',
          href: 'https://free2z.com'
          // href: '/'
        },
        items: [
          {
            // type: 'link',
            // doc: 'index',
            to: '/',
            label: 'Home',
            activeBaseRegex: '^/docs/$',
          },
          {
            // type: 'doc',
            // docId: 'overview',
            // position: 'left',
            // label: 'Overview',
            doc: "overview",
            label: "Overview",
            to: "overview",
            // to: '/overview',
            // activeBaseRegex: '^overview$'
            // activeBaseRegex: 'overview',
          },
          {
            doc: 'getting-started',
            label: 'Getting Started',
            to: 'getting-started',
          },
          // {
          //   doc: 'features',
          //   label: 'Features',
          //   to: 'features',
          //   className: "navbar-item-to-hide",
          // },
          {
            // type: 'doc',
            doc: 'for-creators',
            to: 'for-creators',
            // position: 'left',
            label: 'For Creators',
            // to: 'category/for-creators',
          },
          {
            doc: 'for-supporters',
            to: 'for-supporters',
            // position: 'left',
            label: 'For Supporters',
            // to: '/supporters/overview',
          },
          {
            doc: 'privacy-and-security',
            to: 'privacy-and-security',
            label: 'For Anons',
          },
          {
            doc: "revenue-sharing",
            to: "revenue-sharing",
            label: "Revenue Sharing",
            className: "navbar-item-to-hide",
          },
          {
            doc: "privacy-and-security",
            to: "privacy-and-security",
            label: "Privacy & Security",
            className: "navbar-item-to-hide",
          },
          {
            doc: "legal",
            to: "legal",
            label: "Legal",
            // className: "navbar-item-to-hide",
          },
          {
            doc: "consulting",
            to: "consulting",
            label: "Consulting",
            className: "navbar-item-to-hide",
          },
          {
            href: 'https://github.com/free2z',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              {
                label: 'Overview',
                to: '/docs/overview',
              },
              {
                label: 'Getting Started',
                to: '/docs/getting-started',
              },
              {
                label: 'For Creators',
                to: '/docs/for-creators',
              },
              {
                label: 'For Supporters',
                to: '/docs/for-supporters',
              },
              {
                label: 'What are 2Zs?',
                to: '/docs/getting-started/tuzis',
              },
            ],
          },
          {
            title: 'Social',
            items: [
              // {
              //   label: 'Stack Overflow',
              //   href: 'https://stackoverflow.com/questions/tagged/docusaurus',
              // },
              // {
              //   label: 'Discord',
              //   href: 'https://discordapp.com/invite/docusaurus',
              // },
              {
                label: "Free2Z Official",
                href: "https://free2z.com/free2z",
              },
              {
                label: 'Twitter',
                href: 'https://twitter.com/free2zcash',
              },
              {
                label: 'GitHub',
                href: 'https://github.com/free2z',
              },
            ],
          },
          // TODO: kinda needs 3 sections down here ;/
          // Zcash Forum?
          // Discord?
          // ...
          // Mastodon
          // ... zPages ... profile, login ... ?
          // 3 groups of 4 would probably be best
          // {
          //   title: 'Free2Z',
          //   items: [
          //     {
          //       label: '',
          //       href: 'https://github.com/free2z',
          //     },
          //   ],
          // },
        ],
        copyright: `Copyright © ${new Date().getFullYear()}, 2Z Inc.`,
      },
      prism: {
        theme: lightCodeTheme,
        darkTheme: darkCodeTheme,
      },
    }),
};

module.exports = config;
