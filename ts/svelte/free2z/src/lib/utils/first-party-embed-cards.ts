/**
 * First-party CONTENT cards for `::embed[…]` of a zPage or a converse thread
 * ( part 2).
 *
 * `first-party-embed.ts` decides WHAT an embed is (by an allow-list of route
 * shapes). This module decides what a reader is allowed to SEE of it, and the
 * answer is always "exactly what the reader would see by opening the URL":
 *
 *  - A card is built only from our own API, called with the READER's
 *    credentials (the SSR loader forwards the reader's own cookie and nothing
 *    else — `$lib/server/first-party-embed-cards.ts`). It is never built from
 *    the author's view, never from a privileged service call, and never by
 *    fetching or following the route itself: the route may be a redirect.
 *
 *  - It is built only when that call is the SAME call the route makes and it
 *    answers with the full, ungated object. Draft, deleted, deactivated-creator
 *    and hidden-thread content is a 404 there; a subscriber-only page for a
 *    non-subscriber is the redacted `{show_modal, page}` upsell. Every one of
 *    those — and a timeout, a 5xx, a username that does not match, a card
 *    over the per-page cap — renders the SAME neutral link card, so an embed
 *    tells the reader strictly less than visiting the URL would (visiting a
 *    subscriber-only page shows its title behind the modal; the neutral card
 *    does not).
 *
 *  - A card is TEXT: a title, `@author`, a plain-text excerpt and the path it
 *    links to. No HTML from the API is ever rendered: the excerpt is the
 *    markdown reduced to plain text and then escaped like every other string
 *    the renderer emits, and the whole article still goes through the one
 *    sanitizer. Because it is plain text, a card cannot contain another card —
 *    an embedded page's own `::embed[]`s are reduced to their link text — so
 *    self-embeds and A↔B cycles terminate at one level by construction.
 *
 *  - The link is the path WE build: `zpageCanonicalPath` of the API's own
 *    answer for a zPage, `/converse/<uuid>` for a thread. Of the author's
 *    query and fragment only a normalized `?lang=` (a translated-article
 *    deep link) and a plain anchor survive, and the label shows them, so a
 *    card cannot look like one page while its link carries
 *    `?next=//evil.example` somewhere else.
 *
 *  - Only the host being read resolves: a card is looked up by a key that
 *    carries the embed's host, and the loader resolves only embeds of
 *    `firstPartyCardHost(event.url.hostname)`. Stage never puts its own
 *    database's page behind a `free2z.cash` label.
 *
 * Isomorphic and pure: the renderer (SSR and browser) reads these types and
 * validators; only the loader in `$lib/server` performs any fetch.
 */
import {
  classifyFirstPartyEmbed,
  isFirstPartyHost,
  type FirstPartyEmbed,
} from "./first-party-embed";
import * as env from "$app/env/public";
import { zpageCanonicalPath } from "$lib/zpage-path";
import {
  explicitArticleLanguage,
  normalizeContentLanguage,
  resolveArticleLanguage,
  variantLanguageRetry,
} from "$lib/zpage-language.js";

/**
 * The most content cards ONE page render resolves. Each one is an extra
 * backend call on the SSR path — on top of the three every zPage render
 * already makes — so this is a hard ceiling, not a default: embeds past it
 * (in document order, duplicates counted once) render as neutral link cards
 * and are never fetched.
 */
export const MAX_FIRST_PARTY_CARDS = 4;

/** Card text limits, in UTF-16 code units, ellipsis included. */
export const FIRST_PARTY_CARD_TITLE_MAX = 120;
export const FIRST_PARTY_CARD_EXCERPT_MAX = 240;
/**
 * How much of an embedded page's markdown is reduced to text for its excerpt.
 * The excerpt is 240 characters; reducing a 100 000-character article to find
 * them would put a full second markdown render per card on the SSR path.
 */
export const FIRST_PARTY_CARD_SOURCE_MAX = 4_000;

export type FirstPartyContentEmbed = Extract<
  FirstPartyEmbed,
  { kind: "zpage" } | { kind: "converse" }
>;

export type FirstPartyCard = {
  kind: "zpage" | "converse";
  /** Root-relative path WE built; validated again at render time. */
  href: string;
  /** Plain text. */
  title: string;
  /** Plain text. */
  excerpt: string;
  /** A username, or "" when the API did not give a well-formed one. */
  author: string;
  /**
   * zPage only: the page's own identifiers as the API returned them, so a
   * card can be tied back to an `/article/<id>` embed whose link is the
   * pretty path. "" for a converse card, or when absent.
   */
  vanity?: string;
  free2zaddr?: string;
};

/** Resolved cards by `firstPartyContentKey`. Absent = neutral link card. */
export type FirstPartyCardMap = Record<string, FirstPartyCard>;

// Same shapes the classifier accepts, re-checked here because a card href is
// a sink: whatever reaches the renderer through options must still be one of
// our own content routes, root-relative, with no query and no fragment.
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,149}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Username as displayed after `@`. Generous in length, strict in alphabet: a
// username that does not fit is simply not shown.
const USERNAME = /^[A-Za-z0-9_.-]{1,150}$/;
// C0/C1 controls, DEL, and the bidi embeddings/overrides/isolates and marks.
// A card's text sits in its own `dir="auto"` span (isolated), so these cannot
// reorder the rest of the card; they are removed anyway so a title cannot
// display differently from how it reads in the source.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g;

// A fragment worth keeping: a heading anchor (the renderer's heading IDs are
// Unicode — `中文标题`, `résumé` — codex R6) or `comment-<uuid>`. Letters,
// marks, digits, `_` and `-` only, AFTER one decode; anything else the author
// put after `#` is dropped. Re-encoded on output.
const SAFE_FRAGMENT = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}_-]{0,127}$/u;

function safeFragment(hash: string): string {
  if (!hash.startsWith("#") || hash.length > 1024) return "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(hash.slice(1));
  } catch {
    return "";
  }
  return SAFE_FRAGMENT.test(decoded) ? `#${encodeURIComponent(decoded)}` : "";
}

/**
 * The one host whose zPage/converse URLs name content in the database THIS
 * render reads, given the host the reader asked for (`event.url.hostname`,
 * which adapter-node takes from the proxy's `Host`).
 *
 * On a first-party host that is simply the reader's host: production answers
 * for `free2z.cash`, stage for `stage.free2z.cash`. A `free2z.cash` URL
 * embedded in an article read on stage is NOT stage's content — resolving it
 * against stage's database would show stage's page behind a production label
 * (codex review) — so there it stays a link to exactly what was written.
 *
 * Any other host (a developer's `localhost`, the browser suite's `127.0.0.1`,
 * a request with a bogus `Host`) is not a deployment of ours and falls back to
 * the canonical site host — `PUBLIC_CANONICAL_BASE_URL`, default
 * `free2z.cash`, the same default the renderer's `SITE_ORIGIN` uses.
 */
export function firstPartyCardHost(requestHostname?: string | null): string {
  if (requestHostname && isFirstPartyHost(requestHostname)) {
    return requestHostname;
  }
  try {
    return new URL(env.PUBLIC_CANONICAL_BASE_URL || "https://free2z.cash")
      .hostname;
  } catch {
    return "free2z.cash";
  }
}

/** The host an embed was written for (already an exact first-party host). */
export function firstPartyContentHost(embed: FirstPartyContentEmbed): string {
  try {
    return new URL(embed.href).hostname;
  } catch {
    return "";
  }
}

/**
 * The only parts of the author's query and fragment that survive: a zPage's
 * `?lang=` REPRESENTATION selector (a translated-article deep link), after the
 * same normalization the article route applies, and a plain anchor fragment.
 * Everything else — `?next=`, tracking parameters, script-looking fragments —
 * is dropped, and what survives is shown in the card's label.
 */
export function firstPartyContentSelectors(embed: FirstPartyContentEmbed): {
  lang: string | null;
  suffix: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(embed.href);
  } catch {
    return { lang: null, suffix: "" };
  }
  const lang =
    embed.kind === "zpage"
      ? explicitArticleLanguage(parsed.searchParams.get("lang"))
      : null;
  const fragment = safeFragment(parsed.hash);
  return {
    lang,
    suffix: `${lang ? `?lang=${encodeURIComponent(lang)}` : ""}${fragment}`,
  };
}

/**
 * The one key a content embed is known by, in the card map and in the cap:
 * the host it names (so a card resolved for this deployment can never be
 * looked up for another environment's URL), the content it names (usernames
 * fold case; identifiers do not) and, for a zPage, the language asked for.
 */
export function firstPartyContentKey(embed: FirstPartyContentEmbed): string {
  const host = firstPartyContentHost(embed);
  if (embed.kind === "converse") {
    return `converse:${host}/${embed.uuid.toLowerCase()}`;
  }
  const { lang } = firstPartyContentSelectors(embed);
  return `zpage:${host}/${(embed.username ?? "").toLowerCase()}/${embed.identifier}${lang ? `?lang=${lang}` : ""}`;
}

/**
 * The API path one embed is resolved from. Segments have already passed the
 * classifier's grammar, so they cannot carry `/`, `..` or `%`.
 */
export function firstPartyCardApiPath(embed: FirstPartyContentEmbed): string {
  if (embed.kind === "converse") {
    return `/api/comments/${encodeURIComponent(embed.uuid.toLowerCase())}/`;
  }
  return `/api/zpage/${encodeURIComponent(embed.identifier)}/`;
}

/**
 * What one embed costs against `MAX_FIRST_PARTY_CARDS`: the API call it needs
 * (path plus the embed's own `?lang=`; with none, every embed in one render
 * asks in the same reader locale). `/alice/post`, `/ALICE/post` and
 * `/article/post` are three keys but ONE call, so they spend one slot, and the
 * loader makes that call once and fans the answer out to each key — whose
 * own checks (username vs creator, identifier vs page) still run per key.
 */
export function firstPartyFetchKey(embed: FirstPartyContentEmbed): string {
  const { lang } = firstPartyContentSelectors(embed);
  return `${firstPartyContentHost(embed)}${firstPartyCardApiPath(embed)}${lang ? `?lang=${lang}` : ""}`;
}

/**
 * The root-relative path this embed was CLASSIFIED as — its own shape, with no
 * query, fragment or trailing slash. A neutral card links to this path (plus
 * the surviving selectors) on the host the author named, and shows exactly
 * that as its label.
 */
export function firstPartyContentPath(embed: FirstPartyContentEmbed): string {
  if (embed.kind === "converse") return `/converse/${embed.uuid.toLowerCase()}`;
  if (embed.username === null) {
    return `/article/${encodeURIComponent(embed.identifier)}`;
  }
  return `/${encodeURIComponent(embed.username)}/${encodeURIComponent(embed.identifier)}`;
}

/**
 * The `lang` a zPage card is asked for: the embed's own validated `?lang=`,
 * else what the article route would ask for this reader with no `?lang=`
 * (`resolveArticleLanguage` over their UI locale). Card and destination are
 * then the same request.
 */
export function firstPartyCardLanguage(
  embed: FirstPartyContentEmbed,
  uiLocale: string | null | undefined,
): string {
  return resolveArticleLanguage({
    requestedLanguage: firstPartyContentSelectors(embed).lang,
    uiLocale,
  });
}

/** Is this a root-relative path of one of our two content route shapes? */
export function isFirstPartyCardHref(href: unknown): href is string {
  if (typeof href !== "string" || !href.startsWith("/")) return false;
  const parts = href.slice(1).split("/");
  if (parts.length !== 2) return false;
  let first: string;
  let second: string;
  try {
    first = decodeURIComponent(parts[0]);
    second = decodeURIComponent(parts[1]);
  } catch {
    return false;
  }
  // Round-trip: the href must be exactly the encoded form of its segments, so
  // nothing an HTML or URL parser would read differently can hide in it.
  if (`/${encodeURIComponent(first)}/${encodeURIComponent(second)}` !== href) {
    return false;
  }
  if (first === "converse") return UUID.test(second);
  if (!SEGMENT.test(first) || !SEGMENT.test(second)) return false;
  // Anything else must be a shape the classifier itself reads as a zPage —
  // which excludes every static route, nginx-owned prefix and redirect route.
  const reread = classifyFirstPartyEmbed(`https://free2z.cash${href}`);
  return reread?.kind === "zpage";
}

export function cleanCardText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").replace(UNSAFE_TEXT, "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function username(value: unknown): string {
  return typeof value === "string" && USERNAME.test(value) ? value : "";
}

/**
 * Markdown → a short plain-text excerpt, WITHOUT rendering it.
 *
 * The obvious tool, `extractPlainText`, runs the whole markdown renderer and
 * DOMPurify first — synchronous, author-controlled work whose cost depends on
 * structure (nesting depth, emphasis runs), not on length. Four embedded pages
 * of `"> ".repeat(1900)` blocked the SSR event loop for ~4 s, and no deadline
 * can interrupt synchronous work (codex R5). So the excerpt is made by a
 * bounded number of single-pass replacements over at most
 * `FIRST_PARTY_CARD_SOURCE_MAX` characters: every pattern below is a plain
 * character class or a bounded quantifier with no nested repetition, so each
 * pass is linear in the input. It is a summary, not a rendering; odd markdown
 * just leaves a stray character, and the result is escaped at render time.
 */
export function markdownExcerptText(source: unknown, max: number): string {
  if (typeof source !== "string" || !source) return "";
  const text = source
    .slice(0, FIRST_PARTY_CARD_SOURCE_MAX)
    // Front matter, code fences, math fences: drop the fence markers only.
    .replace(/^ {0,3}(?:```|~~~|\$\$|---)[^\n]*$/gm, " ")
    // `::embed[https://host/path]` and friends: the destination, no scheme.
    .replace(
      /::(?:embed|iframe|qrcode)\[(?:https?:\/\/)?([^\]\n]{0,500})\]/gi,
      "$1",
    )
    // Images and links: their text. Footnote references: nothing.
    .replace(/!?\[([^\]\n]{0,300})\]\([^)\n]{0,2000}\)/g, "$1")
    .replace(/\[\^[^\]\n]{0,100}\]:?/g, "")
    // Raw HTML tags.
    .replace(/<[^<>\n]{0,500}>/g, " ")
    // Line-leading block markers: headings, quotes, list bullets/numbers.
    .replace(/^[ \t]{0,12}(?:[#>]+|[-*+]|\d{1,9}[.)])[ \t]*/gm, "")
    .replace(/^[ \t>]+/gm, "")
    // Emphasis / code / strike markers and backslash escapes.
    .replace(/[*_~`]+/g, "")
    .replace(/\\(.)/g, "$1");
  return cleanCardText(text, max);
}

function excerptOf(source: unknown): string {
  return markdownExcerptText(source, FIRST_PARTY_CARD_EXCERPT_MAX);
}

/**
 * A zPage card from the body of `GET /api/zpage/<identifier>/` as the READER
 * received it, or `null` for the neutral card.
 *
 * `null` whenever the answer is anything but the full, ungated page, and
 * whenever the page's real creator is not the username the URL named: the
 * API resolves an identifier globally, so `/<someone-else>/<vanity>` would
 * otherwise put one creator's article under another creator's URL — and a
 * username that is not a creator at all (`/accounts/logout`) must not borrow
 * the card of whichever page happens to own that vanity.
 */
export function zpageCardFromApi(
  embed: Extract<FirstPartyContentEmbed, { kind: "zpage" }>,
  body: unknown,
  /** The `lang` the loader asked the API for (see `firstPartyCardLanguage`). */
  askedLanguage: string | null = null,
): FirstPartyCard | null {
  const page = record(body);
  if (!page) return null;
  // The subscriber-only upsell (`RedirectWithModalException`): a 200 whose
  // body is `{show_modal, page}` with the content redacted. Gated.
  if ("show_modal" in page || "page" in page) return null;
  const creator = record(page.creator);
  const creatorName = username(creator?.username);
  if (!creatorName) return null;
  if (
    embed.username !== null &&
    embed.username.toLowerCase() !== creatorName.toLowerCase()
  ) {
    return null;
  }
  const href = zpageCanonicalPath({
    creator: { username: creatorName },
    vanity: typeof page.vanity === "string" ? page.vanity : null,
    free2zaddr: typeof page.free2zaddr === "string" ? page.free2zaddr : null,
  });
  if (!isFirstPartyCardHref(href)) return null;
  // The card must describe the variant its link will OPEN. The API matches
  // `lang` exactly and otherwise falls back, while the article route then
  // resolves a range with a second request (`zh` -> `zh-Hans`, an `en`
  // reader -> `en-US`). When the route would take that second step, this
  // answer is not what the reader lands on, so the card is neutral (codex
  // review) — the same `variantLanguageRetry` rule, asked with the same
  // language the loader asked the API for.
  if (
    variantLanguageRetry({
      askedLanguage,
      actualLanguage: page.actual_language,
      availableLanguages: Array.isArray(page.available_languages)
        ? page.available_languages
        : null,
    })
  ) {
    return null;
  }
  const title = cleanCardText(page.title, FIRST_PARTY_CARD_TITLE_MAX);
  if (!title) return null;
  const description =
    typeof page.description === "string" && page.description.trim()
      ? page.description
      : page.content;
  return {
    kind: "zpage",
    href,
    title,
    excerpt: excerptOf(description),
    author: creatorName,
    vanity: typeof page.vanity === "string" ? page.vanity : "",
    free2zaddr: typeof page.free2zaddr === "string" ? page.free2zaddr : "",
  };
}

// Identifier-ish strings on a card: the classifier's own segment grammar.
const CARD_IDENTIFIER = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,149}$/;

function cardIdentifier(value: unknown): string {
  return typeof value === "string" && CARD_IDENTIFIER.test(value) ? value : "";
}

/**
 * Does this zPage card describe the page THIS embed names? The render options
 * are data from our own loader, but a card must still never render under a
 * key it does not belong to (`{href: "/bob/other"}` under alice/post's key):
 *
 *  - `/<username>/<identifier>`: the card's link must be in that username's
 *    namespace (case-folded — usernames are case-insensitive here). The
 *    loader already refused a page whose creator is not that username.
 *  - `/article/<identifier>`: no username to compare, so the identifier must
 *    be the card's own immutable address exactly, or its vanity
 *    case-insensitively (the API's own lenient matching; a slugified legacy
 *    spelling that matches neither is simply the neutral card).
 */
function zpageCardBelongsTo(
  embed: Extract<FirstPartyContentEmbed, { kind: "zpage" }>,
  href: string,
  vanity: string,
  free2zaddr: string,
): boolean {
  if (embed.username !== null) {
    let owner: string;
    try {
      owner = decodeURIComponent(href.slice(1).split("/")[0] ?? "");
    } catch {
      return false;
    }
    return owner.toLowerCase() === embed.username.toLowerCase();
  }
  return (
    (!!free2zaddr && embed.identifier === free2zaddr) ||
    (!!vanity && embed.identifier.toLowerCase() === vanity.toLowerCase())
  );
}

/**
 * A converse card from the body of `GET /api/comments/<uuid>/` as the READER
 * received it, or `null` for the neutral card. The API scopes a comment to the
 * visibility of what it is attached to (a hidden zPage's or private AI
 * conversation's thread is a 404 there), which is the same call the
 * `/converse/<uuid>` route makes.
 */
export function converseCardFromApi(
  embed: Extract<FirstPartyContentEmbed, { kind: "converse" }>,
  body: unknown,
): FirstPartyCard | null {
  const comment = record(body);
  if (!comment) return null;
  if (
    typeof comment.uuid !== "string" ||
    comment.uuid.toLowerCase() !== embed.uuid.toLowerCase()
  ) {
    return null;
  }
  const href = `/converse/${embed.uuid.toLowerCase()}`;
  if (!isFirstPartyCardHref(href)) return null;
  const excerpt = excerptOf(comment.content);
  const headline = cleanCardText(comment.headline, FIRST_PARTY_CARD_TITLE_MAX);
  const title =
    headline || cleanCardText(excerpt, FIRST_PARTY_CARD_TITLE_MAX) || "";
  if (!title) return null;
  return {
    kind: "converse",
    href,
    title,
    excerpt: headline ? excerpt : "",
    author: username(record(comment.author)?.username),
  };
}

/**
 * A card from the render options is trusted only as far as this goes: it must
 * be the kind the embed is, and link to one of our own content routes.
 */
export function usableFirstPartyCard(
  embed: FirstPartyContentEmbed,
  card: unknown,
): FirstPartyCard | null {
  const value = record(card);
  if (!value || value.kind !== embed.kind) return null;
  if (!isFirstPartyCardHref(value.href)) return null;
  if (
    embed.kind === "converse" &&
    value.href !== firstPartyContentPath(embed)
  ) {
    return null;
  }
  const vanity = cardIdentifier(value.vanity);
  const free2zaddr = cardIdentifier(value.free2zaddr);
  if (
    embed.kind === "zpage" &&
    !zpageCardBelongsTo(embed, value.href, vanity, free2zaddr)
  ) {
    return null;
  }
  const title = cleanCardText(value.title, FIRST_PARTY_CARD_TITLE_MAX);
  if (!title) return null;
  return {
    kind: embed.kind,
    href: value.href,
    title,
    excerpt: cleanCardText(value.excerpt, FIRST_PARTY_CARD_EXCERPT_MAX),
    author: username(value.author),
    ...(embed.kind === "zpage" ? { vanity, free2zaddr } : {}),
  };
}
