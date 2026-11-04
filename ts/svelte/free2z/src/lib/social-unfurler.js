// Plain JS (not TS) so `npm test` (node --test) can import it directly, the
// same way src/lib/streamTypes.js is.

/**
 * The social link-unfurler User-Agent class (Twitterbot, Slackbot,
 * facebookexternalhit, LinkedInBot,...), as nginx classifies it.
 *
 * This is a VERBATIM copy of the `$prerender` regex in `location /` of
 * `k8s/free2z/nginx.conf`. `bin/test-prerender-ua-tiers.py` reads both files
 * and fails if they differ, so this is one list stated twice, not two lists.
 * `String.raw` keeps the backslashes byte-identical to the nginx source.
 *
 * Nothing here is an access decision. The one consumer  is the
 * paid / members live-stream page, which lets an anonymous request in this
 * class render the creator's PUBLIC card instead of a 302 to /login. A spoofed
 * User-Agent therefore buys only what `/api/creator/{username}/` already
 * serves to anyone; the meeting itself is still gated by the API (401/402).
 */
export const SOCIAL_UNFURLER_UA_PATTERN = String.raw`firefox/24\.0|discourse|whatsapp/|slackbot|slack-imgproxy|discordbot|telegrambot|facebookexternalhit|facebookcatalog|twitterbot|curl/|crawler|embedly|skypeuripreview|link preview|pinterestbot|pinterest/0\.|vkshare|validator|uptime|rss|feed|iframely|linkedinbot|redditbot|cardyb|mastodon/`;

// nginx's `~*` is a case-insensitive PCRE match anywhere in the string.
const SOCIAL_UNFURLER_UA = new RegExp(SOCIAL_UNFURLER_UA_PATTERN, "i");

/**
 * @param {string | null | undefined} userAgent
 * @returns {boolean}
 */
export function isSocialUnfurler(userAgent) {
  return typeof userAgent === "string" && SOCIAL_UNFURLER_UA.test(userAgent);
}
