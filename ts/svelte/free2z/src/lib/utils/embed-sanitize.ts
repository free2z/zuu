import DOMPurify from "isomorphic-dompurify";
import { isExternalEmbedDomain } from "./embed-domains";
import { isCrossOriginHttpUrl } from "./safe-url";

/**
 * Sanitizer for third-party embed HTML — today, whatever `cdn.iframe.ly`
 * returns for an AUTHOR-CHOSEN url (`::embed[https://attacker.example/page]`).
 *
 * The trust model is the point. Iframely is a proxy, not an authority: the page
 * being embedded controls its own oEmbed / `og:video:iframe` metadata, so an
 * author who controls the target page controls the HTML that comes back here.
 * DOMPurify alone is not enough for that, because the dangerous result is not
 * malformed markup — it is a perfectly well-formed `<iframe>` doing exactly
 * what iframes do .
 *
 * `style` stays allowed here — Iframely's responsive wrapper is built from
 * `position:relative` + `padding-bottom:56.25%` and a `position:absolute`
 * child, so a CSS property allowlist tight enough to stop a full-viewport
 * overlay would also flatten every embed's aspect ratio. The overlay is
 * contained geometrically instead: `.iframely-embed-shell` in
 * ExternalEmbed.svelte carries `contain: paint`, which makes the shell the
 * containing block for `absolute` AND `fixed` descendants and clips them to it.
 * Keep that rule and this comment together.
 */

/**
 * Attributes an embed may keep. `sandbox` is in the list because Iframely
 * sometimes sends its own; ours overwrites it unconditionally below.
 */
const EMBED_ALLOWED_ATTRIBUTES = [
  "allow",
  "allowfullscreen",
  "frameborder",
  "height",
  "loading",
  "referrerpolicy",
  "sandbox",
  "scrolling",
  "src",
  "style",
  "width",
];

/**
 * The sandbox forced onto EVERY embedded iframe.
 *
 * Chosen tokens and why each earns its place:
 *   allow-scripts                    every player is a JS app
 *   allow-popups                     "watch on YouTube", "open in Spotify"
 *   allow-popups-to-escape-sandbox   or the popup inherits this sandbox and
 *                                    breaks the destination site
 *   allow-forms                      polls, comment and search widgets
 *   allow-modals                     doc/PDF viewers that call print()/alert()
 *   allow-presentation               casting a video to a second screen
 *
 * Deliberately absent — these are the escape hatches, not features:
 *   allow-top-navigation(-by-user-activation)  a consented embed must never be
 *                                    able to navigate free2z.cash away
 *   allow-downloads                  no drive-by file prompts from an embed
 *   allow-pointer-lock, allow-orientation-lock, allow-storage-access-by-user-
 *   activation                       nothing we host needs them
 *
 * These tokens are a superset of what the direct-provider `<iframe>` in
 * ExternalEmbed.svelte already ships (production-proven against
 * YouTube/Vimeo/Spotify/SoundCloud) plus `allow-modals` and
 * `allow-presentation`, because Iframely fronts a far wider provider set —
 * Google Docs/Drive viewers, Figma, CodePen, Scribd.
 *
 * `allow-same-origin` is NOT here. See EMBED_STORAGE_SANDBOX_TOKENS.
 */
export const EMBED_SANDBOX_TOKENS = [
  "allow-scripts",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-forms",
  "allow-modals",
  "allow-presentation",
].join(" ");

/**
 * The same sandbox plus `allow-same-origin`, granted only to hosts on the app's
 * own embed-provider list.
 *
 * `allow-scripts` + `allow-same-origin` is "no sandbox at all" whenever the
 * framed document ends up SAME-ORIGIN with the embedder: it can then reach
 * `parent.document` and delete its own `sandbox` attribute. Checking the `src`
 * is NOT enough to rule that out, because the check happens before the frame
 * navigates — a cross-origin URL is free to answer
 * `302 Location: https://free2z.cash/...`, and if anything on our origin can be
 * made to serve executable content, the frame lands there scripted and
 * same-origin. We cannot observe a frame's final origin from here, so the grant
 * is made on trust in the HOST rather than on a check we cannot perform.
 *
 * Real players do need it — Spotify, Twitter and YouTube all use storage — so
 * the known-provider list (which includes iframe.ly's own CDN, where Iframely's
 * `iframe=1` responses point) keeps working exactly as before. An unrecognized
 * host still renders and still runs scripts; it just gets an opaque origin, so
 * a redirect back to free2z.cash gains it nothing.
 *
 * Residual risk, stated rather than hidden: an OPEN REDIRECT on a listed
 * provider would still land a same-origin scripted frame. That needs an open
 * redirector on youtube.com / spotify.com / iframe.ly AND attacker-controlled
 * executable content on free2z.cash. The durable fix for the second half is a
 * `frame-ancestors` / `X-Frame-Options` policy on our own responses, which
 * lives in nginx, not here.
 */
export const EMBED_STORAGE_SANDBOX_TOKENS = `${EMBED_SANDBOX_TOKENS} allow-same-origin`;

/**
 * Permissions-Policy features an embed may be delegated through `allow=`.
 *
 * `allow` is a delegation of the READER's permissions, and the browser's
 * consent prompt names the top-level site — so an `allow="camera; microphone;
 * geolocation"` in a hostile Iframely response asks the visitor for their
 * camera on behalf of free2z.cash. Sandboxing does not restrict this, so it
 * gets its own allowlist: the media features real players ask for, and nothing
 * that reaches a sensor, a payment sheet or a device.
 *
 * `clipboard-write` is deliberately NOT here even though YouTube asks for it.
 * On a site where readers copy and paste Zcash addresses, an embed that can
 * replace the clipboard contents on a plausible "play" click is an address-swap
 * primitive that costs someone real money. The price of refusing it is a broken
 * "copy link" button inside a third-party player.
 */
const EMBED_ALLOWED_PERMISSIONS = new Set([
  "accelerometer",
  "autoplay",
  "encrypted-media",
  "fullscreen",
  "gyroscope",
  "picture-in-picture",
  "web-share",
]);

/**
 * Iframely hosts frames on `iframely.net` as well as `iframe.ly`, and
 * EXTERNAL_EMBED_DOMAINS (shared with the consent gate) only lists the latter.
 * Adding it there would change which URLs are treated as "external" for consent
 * purposes, so the storage-trust list is widened here instead. Production CSP
 * already allows `*.iframely.net`.
 */
const EXTRA_STORAGE_TRUSTED_HOSTS = ["iframely.net"];

function isStorageTrustedHost(src: string): boolean {
  if (isExternalEmbedDomain(src)) {
    return true;
  }

  try {
    const hostname = new URL(src).hostname.toLowerCase();
    return EXTRA_STORAGE_TRUSTED_HOSTS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

function filterAllowAttribute(value: string): string {
  return value
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (!entry) return false;
      // `camera 'self' https://x.example` -> feature name is the first token.
      const feature = entry.split(/\s+/)[0].toLowerCase();
      return EMBED_ALLOWED_PERMISSIONS.has(feature);
    })
    .join("; ");
}

/**
 * Sanitize provider HTML and force our iframe policy onto what survives.
 *
 * `pageOrigin` is the origin the HTML will be inserted into — `location.origin`
 * in the browser. It is a parameter rather than a global read so this stays a
 * pure function that can be tested without a live page (and so it does not
 * touch `window`, which would break if this module is ever imported on the SSR
 * path).
 */
export function sanitizeEmbedHtml(html: string, pageOrigin: string): string {
  if (!html) {
    return "";
  }

  // RETURN_DOM gives us the sanitized tree to harden before it is serialized,
  // instead of a string we would have to re-parse (or, worse, regex).
  const body = DOMPurify.sanitize(html, {
    ADD_TAGS: ["iframe"],
    // A legitimate `iframe=1&omit_script=1` response is a wrapper div and an
    // iframe — never a form control. Allowing them lets a hostile provider
    // paint a "your Free2Z session has expired" login form in OUR chrome, with
    // no script and no iframe involved, and post the credentials wherever it
    // likes. Nothing is lost by refusing them: real form UI lives inside the
    // provider's own iframe, which this never reaches.
    //
    // `style` is here for a different reason: CSS selectors are DOCUMENT-wide.
    // A `<style>` smuggled through a provider response is not contained by
    // anything this file does — not the iframe sandbox, not `contain: paint`,
    // not the `max-height` cap — because it can target `html`, `body`, our
    // navigation or our forms directly. Production CSP allows inline styles
    // (`style-src 'unsafe-inline'`), so it applies. Nothing Iframely returns
    // needs one; the responsive wrapper is built from `style=` ATTRIBUTES,
    // which this does not touch. Same reasoning as `FORBID_TAGS: ["style"]` in
    // markdown-sanitize.ts  — a second sanitizer needs the same answer.
    FORBID_TAGS: [
      "button",
      "form",
      "input",
      "label",
      "option",
      "select",
      "style",
      "textarea",
    ],
    ADD_ATTR: EMBED_ALLOWED_ATTRIBUTES,
    ALLOWED_URI_REGEXP: /^(?:https?:|\/(?!\/)|[#?]|[^:/?#]+(?:[/?#]|$)|$)/i,
    RETURN_DOM: true,
  }) as unknown as HTMLElement;

  for (const iframe of Array.from(body.querySelectorAll("iframe"))) {
    // `srcdoc` runs in a document that INHERITS our origin, which would make
    // `allow-same-origin` below a real sandbox escape. There is no legitimate
    // Iframely response that needs it.
    iframe.removeAttribute("srcdoc");

    const src = iframe.getAttribute("src");
    if (!src || !isCrossOriginHttpUrl(src, pageOrigin)) {
      // No src, a non-http(s) scheme, or a frame pointing back at free2z.cash.
      // The last is the one that matters: same-origin + allow-same-origin +
      // allow-scripts lets the frame delete its own sandbox attribute.
      iframe.remove();
      continue;
    }

    iframe.setAttribute(
      "sandbox",
      isStorageTrustedHost(src)
        ? EMBED_STORAGE_SANDBOX_TOKENS
        : EMBED_SANDBOX_TOKENS,
    );

    const allow = iframe.getAttribute("allow");
    if (allow) {
      const filtered = filterAllowAttribute(allow);
      if (filtered) {
        iframe.setAttribute("allow", filtered);
      } else {
        iframe.removeAttribute("allow");
      }
    }
  }

  return body.innerHTML;
}
