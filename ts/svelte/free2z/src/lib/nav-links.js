/**
 * Site navigation links, in one place.
 *
 * Below `md` the homepage feed scrolls indefinitely, so the footer is never
 * reached and the mobile menu is the ONLY route to Terms, Privacy and Help.
 *
 * MobileNavMenu renders from this list. The desktop footer still hard-codes
 * the same destinations (it decorates each with a per-link icon this list
 * does not model) — so adding a link here does NOT add it to the footer, and
 * vice versa. Folding the footer onto this list is worth doing; until then,
 * treat the two as needing to be edited together.
 *
 * `reload: true` means the target is served by the Docusaurus docs site
 * rather than SvelteKit, so the link needs a full navigation
 * (`data-sveltekit-reload`) instead of client-side routing.
 *
 * @typedef {object} NavLink
 * @property {string} href
 * @property {string} key      i18n key
 * @property {string} fallback English text when the key is missing
 * @property {boolean} [reload] full page navigation rather than client routing
 * @property {boolean} [external]
 */

/**
 * Things you can do on Free2Z. @type {NavLink[]}
 *
 * `/converse` is the microblog stream — every standalone post and reply on the
 * platform. Its only entrance used to be one unlabeled navbar glyph, which
 * meant it was absent from the mobile menu and the footer entirely; it is in
 * this list so both get it and cannot drift apart again.
 */
export const EXPLORE_LINKS = [
  { href: "/creators", key: "creators.title", fallback: "Creators" },
  { href: "/trending", key: "homepage.trending", fallback: "Trending" },
  { href: "/converse", key: "converse.title", fallback: "Converse" },
];

/** Documentation and help. @type {NavLink[]} */
export const RESOURCE_LINKS = [
  {
    href: "/free2z",
    key: "footer.status",
    fallback: "Status & updates",
  },
  {
    href: "/docs/",
    key: "footer.documentation",
    fallback: "Documentation",
    reload: true,
  },
  {
    href: "/docs/getting-started/",
    key: "footer.help",
    fallback: "Help center",
    reload: true,
  },
  {
    href: "/docs/privacy-and-security/",
    key: "footer.security",
    fallback: "Privacy & security",
    reload: true,
  },
];

/** Legal. @type {NavLink[]} */
export const LEGAL_LINKS = [
  {
    href: "/docs/legal/",
    key: "footer.terms",
    fallback: "Terms of service",
    reload: true,
  },
  {
    href: "/docs/legal/privacy-policy/",
    key: "footer.privacy",
    fallback: "Privacy policy",
    reload: true,
  },
];

/** Community and off-site destinations. @type {NavLink[]} */
export const SOCIAL_LINKS = [
  {
    href: "https://x.com/free2zcash",
    key: "footer.xLabel",
    fallback: "Free2Z on X",
    external: true,
  },
  {
    href: "https://github.com/free2z/zuu",
    key: "footer.githubLabel",
    fallback: "Free2Z on GitHub",
    external: true,
  },
  {
    href: "/free2z",
    key: "footer.communityLabel",
    fallback: "Free2Z community profile",
  },
];
