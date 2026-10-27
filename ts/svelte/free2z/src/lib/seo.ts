export const SITE_NAME = "Free2Z";
export const CANONICAL_ORIGIN = "https://free2z.cash";
export const SITE_DESCRIPTION =
  "A publishing platform where independent creators share stories, build communities, and earn support directly from their audience.";
export const DEFAULT_SOCIAL_IMAGE = "/brand/free2z-og.png?v=2";
export const DEFAULT_SOCIAL_IMAGE_ALT =
  "Free2Z — independent publishing, discovery, and direct creator support";
export const DEFAULT_SOCIAL_IMAGE_WIDTH = 1200;
export const DEFAULT_SOCIAL_IMAGE_HEIGHT = 630;
export const DEFAULT_ROBOTS =
  "index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1";
export const NOINDEX_ROBOTS = "noindex, nofollow, noarchive";
// Crawlable but not indexable: real, linkable, link-worthy surfaces whose own
// content has no standalone search value (search results, non-canonical
// trending slices, the ephemeral live-stream viewer). `follow`, not `nofollow`,
// so whatever equity they collect reaches the durable pages they link to.
// Byte-identical to `NOINDEX_FOLLOW` in py/dj/apps/g12f/views/crawler.py --
// the two tiers must say the same thing about the same URL, and
// tests/live-route-seo.test.mjs pins that.
export const NOINDEX_FOLLOW_ROBOTS = "noindex, follow";

// Attribution identities the Django crawler-prerender tier has always emitted,
// copied verbatim from `py/dj/apps/g12f/templates/zpage/social.html` (and its
// siblings under `templates/{creator,comments,crawler}/`) so that retiring that
// tier — issue, phase 3 — cannot change a single card. Do not "improve"
// these values here: SSR must be a strict superset of the card tier first, and
// any change to what the handles say is a separate, deliberate decision.
//
// `twitter:creator` is the *platform* account on purpose. Django hardcodes
// `@free2zcash` for it everywhere, and the zPage API payload carries no
// per-author handle at all (`SimpleCreator` has username/full_name/avatar and
// nothing else; the linked `TwitterProfileSummary` only appears on
// `CreatorProfileDetail`). Deriving a real author handle needs a serializer
// change, so it stays a follow-up rather than an invented value here.
export const TWITTER_SITE = "@free2zcash";
export const TWITTER_CREATOR = "@free2zcash";
export const FACEBOOK_APP_ID = "278755727751440";

export type JsonLd = Record<string, unknown>;
export function buildSeoTitle(title: string) {
  return title.includes(SITE_NAME) ? title : `${title} | ${SITE_NAME}`;
}

/**
 * The bound on a derived meta description, in CODE POINTS, ellipsis included.
 *
 * Google renders ~155–160 characters of a description on desktop and fewer on
 * mobile, and indexes more than it renders; X, Facebook and Slack all stop well
 * before 300 (the bound the Django card tier used until ). 200 sits above
 * every display window and below every consumer's ceiling, and it is what this
 * tier — the one Google actually reads — has always used, so reconciling the
 * two tiers on it does not move Google's snippet while  /  are open.
 */
export const META_DESCRIPTION_CHARS = 200;

/**
 * How much of the RAW value the derivation is allowed to read, in code points.
 *
 * Not a nicety — it is the other half of the parity fix. The Django tier only
 * ever holds a 4,000-character `Substr` of `content` (`CARD_BODY_CHARS`, so the
 * 100,000-character body is never loaded on the sync gunicorn worker), while
 * this tier's caller has the WHOLE article from the API. Same article,
 * different input, therefore different output — the exact divergence  is
 * about, reintroduced one layer above the shared rules. Reproduction: an
 * article opening with a 5,000-character fenced code block. Django saw an
 * unterminated fence and fell back; SSR saw the closing fence and used the
 * prose after it. Clamping HERE means neither caller can feed a different
 * window. Must equal `DESCRIPTION_SOURCE_CHARS` in
 * py/dj/apps/g12f/meta_description.py.
 */
export const DESCRIPTION_SOURCE_CHARS = 4000;

/** U+2026. One code point in both runtimes. */
const ELLIPSIS = "…";

/**
 * A truncation is only pulled back to a word boundary when doing so keeps at
 * least this much of the window; otherwise one very long token (a URL) would
 * collapse the description to almost nothing. Integer arithmetic on purpose —
 * `maxLength * 0.4` is 80.00000000000001 for 200 in IEEE 754 and the two
 * runtimes have to agree on the integer.
 */
function wordBoundaryFloor(maxLength: number) {
  return Math.floor((maxLength * 2) / 5);
}

/**
 * Reduce markdown (or plain text, or HTML) to one line of prose.
 *
 * **This is one half of a cross-runtime contract.** The other half is
 * `strip_markdown()` / `compact_text()` in `py/dj/apps/g12f/meta_description.py`,
 * which the Django crawler-prerender tier uses. nginx splits crawlers by
 * User-Agent (`$seobot` → here, `$prerender` → Django), so before  Google
 * and Slack were handed different strings for the same article at the same
 * moment: 200 chars vs 300, word boundary vs mid-word, markdown stripped vs
 * raw `# Maps` and `::embed[…]` sitting in the attribute across three lines.
 *
 * The rules are pinned by a golden table that BOTH suites assert against:
 *
 *   py/dj/apps/g12f/testdata/meta_description_parity.json
 *     ← ts/svelte/free2z/tests/meta-description-parity.test.mjs
 *     ← py/dj/apps/g12f/test_meta_description.py
 *
 * Change a regex here without changing its twin there and both go red.
 *
 * Not a markdown renderer and not trying to be one: it removes the constructs
 * that make a meta description look broken and leaves everything else alone —
 * including `#hashtag`, `a > b`, and `snake_case`. The last one is a real
 * defect this replaced: the old `[#*_>\`~|]` character class turned
 * `https://youtu.be/abc_DEFgh12?si=sample_under_score` into `…si=AAMiA b4jz8To4ik`
 * and published the broken URL in Google's snippet for
 * /example_creator/video-example.
 *
 * Known limitation, shared with the Python twin: backslash escapes are
 * unwrapped FIRST, before any marker is stripped, so `\*literal\*` yields
 * `literal` rather than `*literal*` — clean text, but the escaped character
 * does not survive as a literal. The other order leaves a stray `\` in the
 * attribute once the `*` it protected is gone, which is worse.
 */
export function stripMarkdown(value: string | null | undefined) {
  // Code points, not `.slice()`: the two runtimes must clamp at the same
  // character. See DESCRIPTION_SOURCE_CHARS for why there is a clamp at all.
  const source = Array.from(value ?? "");
  return (
    (
      source.length > DESCRIPTION_SOURCE_CHARS
        ? source.slice(0, DESCRIPTION_SOURCE_CHARS).join("")
        : (value ?? "")
    )
      .replace(/\r\n?/g, "\n")
      // Every whitespace-ish character EXCEPT `\n`, folded to a plain space up
      // front. `\n` has to survive — the block rules below are line-anchored —
      // and the fold itself is what makes the two runtimes comparable at all:
      // Python's `\s` and ECMAScript's `\s` are NOT the same set (Python has
      // U+001C–U+001F and U+0085, JavaScript has U+FEFF), so leaving a later
      // `\s+` collapse to resolve them would make `alpha\u0085beta` one word in
      // Django and leave a raw control character in this tier's meta attribute.
      // After this line the only whitespace anywhere is `\n` and U+0020.
      //
      // U+200B/U+200C/U+200D are deliberately NOT here: ZWNJ and ZWJ carry
      // meaning, and stripping them splits `👩\u200d💻` into two emoji and
      // changes Persian and Indic shaping (codex adversarial review).
      .replace(
        /[\t\v\f\u001C-\u001F\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/g,
        " ",
      )
      // Fenced code: terminated first, then whatever dangles to end-of-text — an
      // unterminated fence in a truncated excerpt is the common case here.
      // LINE-ANCHORED, like every real markdown tokenizer: unanchored, the prose
      // `Type ``` to open a block` reads as an unterminated fence and deletes the
      // rest of the description (codex adversarial review). A stray inline run of
      // backticks is handled by the generic backtick strip further down.
      // The backreference is not decoration: CommonMark (and the app's own
      // renderer, markdown.ts) requires the CLOSING fence to be at least as long
      // as the opening one. A fixed ``` pattern reads the literal ``` line inside
      // a four-backtick block as the close, then reads the real close as a fresh
      // unterminated opener — publishing code from inside the block and deleting
      // the prose after it.
      // The info string is `[^`\n]*`, not `[^\n]*`: CommonMark forbids a backtick
      // in a backtick fence's info string, and allowing one lets the capture
      // BACKTRACK — a ```` opener matches as ``` with the fourth backtick
      // absorbed as info, so an inner ``` line closes it.
      .replace(
        /^[ \t]{0,3}(`{3,})[^`\n]*\n[\s\S]*?^[ \t]{0,3}\1`*[ \t]*$/gm,
        " ",
      )
      .replace(/^[ \t]{0,3}`{3,}[\s\S]*/gm, " ")
      .replace(
        /^[ \t]{0,3}(~{3,})[^~\n]*\n[\s\S]*?^[ \t]{0,3}\1~*[ \t]*$/gm,
        " ",
      )
      .replace(/^[ \t]{0,3}~{3,}[\s\S]*/gm, " ")
      // Escapes are unwrapped HERE, before any marker is stripped. The other
      // order leaves a stray `\` in the attribute once the `*` it protected has
      // been removed, which is worse than losing the literal.
      .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1")
      // `::embed[/uploadz/public/example/clip.mp4]` — never useful description
      // text; on /example_creator/maps it WAS the entire meta description.
      //
      // Deliberately as NARROW as the one tokenizer that turns these into
      // widgets, `src/lib/utils/markdown.ts`:
      //   /^ {0,3}::(embed|iframe|qrcode)\[([^\]\n]+)\][ \t]*(?:\n|$)/i
      // line-anchored, three names, brackets required. A broader "any `::name`"
      // rule reads `Use std::vector here` as markup and publishes `Use std here`
      // text the article visibly renders, silently deleted from every card.
      .replace(
        /^[ \t]{0,3}::(?:embed|iframe|qrcode)\[[^\]\n]+\][ \t]*$/gim,
        " ",
      )
      .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, " ")
      .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
      // `<https://example.com>` is an autolink, not a tag; unwrap before the tag
      // pass so the URL is not deleted outright.
      .replace(/<((?:https?|mailto|ftp):[^>\s]+)>/gi, "$1")
      .replace(/<!--[\s\S]*?-->/g, " ")
      // A tag may span newlines (`<img\n src=…>`), hence `[^<>]` rather than
      // `[^>\n]`. Requiring a letter (or `/`, or `!`) after `<` is what keeps
      // `latency < 200 and rate > 5` from being eaten as though it were a tag —
      // which the old `<[^>]*>` and Django's `strip_tags` both got wrong.
      .replace(/<\/?[A-Za-z!][^<>]*>/g, " ")
      // Line-anchored block markers. Anchoring is what lets `#hashtag` and
      // `a > b` survive mid-sentence.
      .replace(/^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/gm, "")
      // Thematic breaks BEFORE list bullets, or `- - -` decays to `- -`.
      .replace(
        /^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/gm,
        " ",
      )
      // A GFM table delimiter row: pipes, colons, dashes, spaces, ≥1 dash.
      // `50-60` is safe — digits are outside the class.
      .replace(/^[ \t]*\|?[-:| \t]*-[-:| \t]*$/gm, " ")
      .replace(/^[ \t]{0,3}(?:>[ \t]?)+/gm, "")
      // `[0-9]`, never `\d`: Python's `\d` matches Unicode digits and this one
      // does not, so an Arabic article opening `١. …` would lose its numbering on
      // the Django tier and keep it here.
      .replace(/^[ \t]{0,3}(?:[-*+]|[0-9]{1,9}[.)])[ \t]+/gm, "")
      .replace(/^\[[ xX]\][ \t]+/gm, "")
      .replace(/`+/g, "")
      // `~~strike~~` only — a bare `~` is a real character in paths like /~user.
      .replace(/~~+/g, "")
      .replace(/\*+/g, "")
      .replace(/\|/g, " ")
      // `_` is emphasis ONLY at a word boundary — CommonMark's own rule, and the
      // fix for the corrupted-URL defect above. Two alternatives rather than a
      // lookbehind: Safari only gained lookbehind in 16.4, which is this app's
      // exact browser floor (.browserslistrc), and an unsupported regex literal
      // is a module-level SyntaxError, not a degraded description.
      .replace(
        /(^|[^0-9A-Za-z_])_+|_+([^0-9A-Za-z_]|$)/g,
        (_match, before?: string, after?: string) =>
          `${before ?? ""} ${after ?? ""}`,
      )
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Bound `text` to `maxLength` CODE POINTS, ellipsis included.
 *
 * Works over `Array.from(text)`, not `.length`: `String.prototype.length`
 * counts UTF-16 code units, so an astral emoji would cost 2 here and 1 in
 * Python and the two tiers would truncate at different places in the same
 * string. `text` is expected to be whitespace-collapsed already, which is what
 * makes the word-boundary search a plain search for the last space.
 */
export function truncateText(text: string, maxLength = META_DESCRIPTION_CHARS) {
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;

  let window = chars.slice(0, maxLength - 1);
  while (window.length && window[window.length - 1] === " ") window.pop();
  const lastSpace = window.lastIndexOf(" ");
  if (lastSpace > wordBoundaryFloor(maxLength))
    window = window.slice(0, lastSpace);
  while (window.length && window[window.length - 1] === " ") window.pop();
  return `${window.join("")}${ELLIPSIS}`;
}

/**
 * Markdown in, one bounded line of prose out.
 *
 * `fallback` is used whenever the stripped value is EMPTY, not merely when it
 * is nullish. The old `value ?? fallback` meant a creator with no bio got an
 * empty `<meta name="description">` — `parsedBio.body` is `''`, not `null` —
 * rather than the profile fallback copy.
 */
export function compactText(
  value: string | null | undefined,
  fallback = SITE_DESCRIPTION,
  maxLength = META_DESCRIPTION_CHARS,
) {
  const text = stripMarkdown(value) || stripMarkdown(fallback);
  return truncateText(text, maxLength);
}

export function toAbsoluteUrl(value: string, origin: string) {
  if (/^https?:\/\//i.test(value)) return value;
  const path = value.startsWith("/") ? value : `/${value}`;
  return `${origin.replace(/\/$/, "")}${path}`;
}

export function canonicalPath(pathname: string) {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

export function escapeJsonForHtml(json: string) {
  return json
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function createOrganizationJsonLd(origin: string): JsonLd {
  return {
    "@type": "Organization",
    "@id": `${origin}/#organization`,
    name: SITE_NAME,
    url: origin,
    description: SITE_DESCRIPTION,
  };
}

export function createWebsiteJsonLd(origin: string): JsonLd {
  return {
    "@type": "WebSite",
    "@id": `${origin}/#website`,
    name: SITE_NAME,
    url: origin,
    description: SITE_DESCRIPTION,
    inLanguage: "en",
    publisher: { "@id": `${origin}/#organization` },
    potentialAction: {
      "@type": "SearchAction",
      target: `${origin}/search?q={search_term_string}`,
      "query-input": "required name=search_term_string",
    },
  };
}

export type PageJsonLdType = "website" | "article" | "profile" | "video.other";

export type PageJsonLdOptions = {
  type: PageJsonLdType;
  origin: string;
  canonicalHref: string;
  title: string;
  description: string;
  imageHref: string;
  imageWidth?: number;
  imageHeight?: number;
  publishedTime?: string;
  modifiedTime?: string;
  author?: string;
  /**
   * The Person/Organization a `type: 'profile'` page is *about*. See
   * `isValidProfileMainEntity()` — without one there is no ProfilePage.
   */
  mainEntity?: JsonLd;
  /**
   * When the profile's underlying entity (the creator's account) came into
   * being. ProfilePage only — Google's recommended property there is
   * `dateCreated`, not `datePublished` (a profile isn't "published" the way
   * an article is), so this is kept distinct from `publishedTime` rather than
   * reusing it under the wrong name. See.
   */
  dateCreated?: string;
  /** Extra top-level `@graph` nodes (breadcrumbs, ItemList, …). */
  extra?: JsonLd[];
};

/**
 * Google's ProfilePage rich result REQUIRES `mainEntity`, and requires that
 * entity to be a Person or Organization identified by `name` OR `alternateName`
 * (the handle) — at least one of the two, not specifically `name`. Search
 * Console reports a page missing `mainEntity` as a *critical* error ("Missing
 * field mainEntity"), which suppresses the feature entirely.
 *
 * Callers pass creator data that is ultimately API-shaped and can be sparse, so
 * validate rather than trust: a ProfilePage we cannot populate correctly is
 * strictly worse than a plain WebPage, because it is the shape that generates
 * the error report. `createPageJsonLd()` degrades to WebPage when this returns
 * false, so an invalid ProfilePage is not representable.
 *
 * Being STRICTER than Google here is its own bug — it silently costs rich-result
 * eligibility with no error anywhere to explain why — so mirror the documented
 * rule, no tighter:
 * https://developers.google.com/search/docs/appearance/structured-data/profile-page
 */
export function isValidProfileMainEntity(value: unknown): value is JsonLd {
  if (!value || typeof value !== "object") return false;
  const entity = value as JsonLd;
  const type = entity["@type"];
  if (type !== "Person" && type !== "Organization") return false;
  const isNonBlank = (field: unknown) =>
    typeof field === "string" && field.trim().length > 0;
  return isNonBlank(entity.name) || isNonBlank(entity.alternateName);
}

/**
 * Google expects ProfilePage dateCreated/dateModified values to be DateTimes,
 * while the public creator API intentionally exposes these at calendar-day
 * precision. Add a neutral UTC midnight only for the JSON-LD consumer; never
 * recover or invent the instant that the API deliberately withholds.
 */
function profileDateTime(value?: string) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return `${value}T00:00:00Z`;
}

/**
 * Build the `@graph` payload for a page's JSON-LD block.
 *
 * Extracted from `SeoHead.svelte` so the structured-data contract is unit
 * testable without rendering a component — the ProfilePage/mainEntity coupling
 * above is exactly the kind of thing that silently regresses in markup.
 */
export function createPageJsonLd(options: PageJsonLdOptions): JsonLd {
  const {
    type,
    origin,
    canonicalHref,
    title,
    description,
    imageHref,
    imageWidth,
    imageHeight,
    publishedTime,
    modifiedTime,
    author,
    mainEntity,
    dateCreated,
    extra = [],
  } = options;

  const hasProfileEntity =
    type === "profile" && isValidProfileMainEntity(mainEntity);
  const pageType = hasProfileEntity
    ? "ProfilePage"
    : type === "article"
      ? "Article"
      : "WebPage";

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": pageType,
        "@id": `${canonicalHref}#webpage`,
        name: title,
        headline: type === "article" ? title : undefined,
        description,
        url: canonicalHref,
        image: imageHref,
        inLanguage: "en",
        isAccessibleForFree: true,
        // `dateCreated` on ProfilePage instead of `datePublished` -- see the
        // `dateCreated` option doc above. Every other page type keeps
        // `datePublished`, unchanged.
        datePublished: hasProfileEntity ? undefined : publishedTime,
        dateCreated: hasProfileEntity
          ? profileDateTime(dateCreated)
          : undefined,
        dateModified: hasProfileEntity
          ? profileDateTime(modifiedTime)
          : modifiedTime,
        author: author ? { "@type": "Person", name: author } : undefined,
        // Nested inline rather than referenced by `@id`. Both are valid
        // JSON-LD, but Google's validator is only reliably transitive within a
        // single node, and an unresolved reference reads to it as an absent
        // field — the very error being fixed.
        mainEntity: hasProfileEntity ? mainEntity : undefined,
        primaryImageOfPage: {
          "@type": "ImageObject",
          url: imageHref,
          width: imageWidth,
          height: imageHeight,
        },
        isPartOf: { "@id": `${origin}/#website` },
        publisher: { "@id": `${origin}/#organization` },
      },
      // A profile entity promoted to `mainEntity` is NOT repeated as a sibling
      // node; it is already in the graph, addressable by its own `@id`.
      ...(type === "profile" && !hasProfileEntity && mainEntity
        ? [mainEntity]
        : []),
      ...extra,
    ],
  };
}

export function createBreadcrumbJsonLd(
  origin: string,
  items: { name: string; path: string }[],
): JsonLd {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: toAbsoluteUrl(item.path, origin),
    })),
  };
}
