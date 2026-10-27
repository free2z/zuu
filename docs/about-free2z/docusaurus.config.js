// @ts-check
// Note: type annotations allow type checking and IDEs autocompletion

const lightCodeTheme = require("prism-react-renderer").themes.github;
const darkCodeTheme = require("prism-react-renderer").themes.dracula;

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "Free2Z",
  tagline: "Free to create, publish, and connect.",
  url: "https://free2z.com",
  baseUrl: "/docs/",
  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "warn",
  favicon: "/docs/img/2Z-Logo.svg",
  // undefined by default... c'mon root
  // trailingSlash: false,

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: "2Z Inc.", // Usually your GitHub org/user name.
  projectName: "Free2Z", // Usually your repo name.

  // Even if you don't use internalization, you can use this field to set useful
  // metadata like html lang. For example, if your site is Chinese, you may want
  // to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: "en",
    // TODO: es!...
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          routeBasePath: "/",
          sidebarPath: require.resolve("./sidebars.js"),
          editUrl:
            "https://github.com/free2z/zuu/edit/main/docs/about-free2z/",
        },
        blog: false,
        theme: {
          customCss: require.resolve("./src/css/custom.css"),
        },
      }),
    ],
  ],

  plugins: [
    // The same legal documents at /docs/plain/…, with no navbar, footer or
    // sidebar and no link except to each other and mailto:. Pages an SDK app
    // opens (the sign-up sheet's Terms link) must be commerce-free, and the
    // ordinary docs navigation reaches "2Z credits" -- "the line", zuu
    // docs/free2z/sdk/INTEGRATION.md. CI checks the built pages
    // ("Check plain legal pages" in.github/workflows/ci.yml).
    [
      "@docusaurus/plugin-content-docs",
      {
        id: "plain",
        // A build-time copy of docs/legal (scripts/sync-legal-plain.mjs).
        path: "legal-plain-generated",
        routeBasePath: "plain",
        sidebarPath: false,
        beforeDefaultRemarkPlugins: [require("./src/legal-plain/remark-legal-links")],
        docsRootComponent: "@site/src/legal-plain/DocsRoot",
        docRootComponent: "@site/src/legal-plain/DocRoot",
        docItemComponent: "@site/src/legal-plain/DocItem",
      },
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: {
        defaultMode: "dark",
        disableSwitch: false,
        respectPrefersColorScheme: false,
      },
      // TODO: doesn't point to relative so points at only prod for
      // some reason..
      image: "img/2Z-Logo.svg",
      navbar: {
        title: "Free2Z",
        logo: {
          alt: "Free2z",
          src: "/docs/img/2Z-Logo.svg",
          href: "https://free2z.com",
          // href: '/'
        },
        items: [
          {
            to: "/docs/",
            label: "Discover Free2Z",
            activeBaseRegex: "^/docs/$",
          },
          { to: "/docs/getting-started/tuzis", label: "2Z credits" },
          { to: "/docs/revenue-sharing/", label: "Earn" },
          { to: "/docs/overview/key-features", label: "Features" },
          { to: "/docs/for-creators/sdk-applications", label: "SDK" },
          {
            href: "https://free2z.com/",
            label: "Open Free2Z",
            position: "right",
          },
        ],
      },
      footer: {
        style: "dark",
        links: [
          {
            title: "Docs",
            items: [
              { label: "Discover Free2Z", to: "/docs/" },
              { label: "2Z credits", to: "/docs/getting-started/tuzis" },
              { label: "Earn", to: "/docs/revenue-sharing/" },
              { label: "Features", to: "/docs/overview/key-features" },
              {
                label: "SDK preview",
                to: "/docs/for-creators/sdk-applications",
              },
              {
                label: "Help and getting started",
                to: "/docs/getting-started/",
              },
              { label: "Privacy", to: "/docs/privacy-and-security/" },
              { label: "Terms of service", to: "/docs/legal/" },
            ],
          },
          {
            title: "Social",
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
                label: "Twitter",
                href: "https://twitter.com/free2zcash",
              },
              {
                label: "GitHub",
                href: "https://github.com/free2z",
              },
            ],
          },
          // TODO: kinda needs 3 sections down here;/
          // Zcash Forum?
          // Discord?
          //...
          // Mastodon
          //... zPages... profile, login... ?
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
