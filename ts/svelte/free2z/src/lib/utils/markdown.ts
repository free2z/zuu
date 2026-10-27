import { Marked, marked, type TokenizerExtension } from "marked";
import hljs from "highlight.js";
import katex from "katex";
import markedFootnote from "marked-footnote";
import { gfmHeadingId } from "marked-gfm-heading-id";
import * as env from "$app/env/public";
import { sanitizeMarkdownHtml } from "./markdown-sanitize";
import { stripMediaDirectivesFromSummary } from "./plainText";
import {
  getSafeHttpUrl,
  getSafeMediaUrl,
  isThirdPartyMediaUrl,
} from "./safe-url";
import { uploadPathKey } from "./embedded-media";
import {
  classifyFirstPartyEmbed,
  firstPartyFileBadge,
  firstPartyUploadSrc,
  isFirstPartyUploadDomain,
  type FirstPartyEmbed,
} from "./first-party-embed";
import {
  MAX_FIRST_PARTY_CARDS,
  firstPartyContentHost,
  firstPartyContentKey,
  firstPartyContentPath,
  firstPartyContentSelectors,
  firstPartyFetchKey,
  usableFirstPartyCard,
  type FirstPartyCardMap,
  type FirstPartyContentEmbed,
} from "./first-party-embed-cards";
import { parseOutboundHttpUrl } from "./outbound-link";

type MathToken = {
  type: "blockMath" | "inlineMath";
  raw: string;
  text: string;
};

type DirectiveToken = {
  type: "blockDirective";
  raw: string;
  name: "embed" | "iframe" | "qrcode";
  value: string;
  block: boolean;
};

let markdownConfigured = false;
// Canonical site origin used to classify author link destinations during SSR,
// where no request/page URL exists. Must match what hydration compares against
// (`window.location.href` on the canonical host) so server and client agree.
const SITE_ORIGIN =
  env.PUBLIC_CANONICAL_BASE_URL?.replace(/\/$/, "") || "https://free2z.cash";
const VIDEO_EXTENSION_PATTERN = /\.(mp4|webm|mov)(?:[?#].*)?$/i;
const AUDIO_EXTENSION_PATTERN =
  /\.(mp3|ogg|wav|m4a|aac|flac|opus)(?:[?#].*)?$/i;

/**
 * Direction is resolved PER BLOCK, here, and not by a `dir` on whatever
 * container the article happens to be rendered in.
 *
 * The container states the base direction of the *prose*, which is what the
 * article's language tag knows. It does not know — and cannot know — that the
 * fenced block four paragraphs down is a shell transcript. A blanket
 * `dir="rtl"` right-aligns that block, reverses the visual order of a `&&`
 * chain's operands around its neutral characters, and puts the prompt on the
 * wrong end of the line; the same happens to a bare URL, where `?a=1&b=2` is
 * all bidi-neutral and reorders around any RTL run beside it.
 *
 * So code and URLs carry their own `dir="ltr"`. That is two statements, not
 * one: `direction: ltr` fixes the base, and — via the HTML standard's UA
 * stylesheet rule `[dir] { unicode-bidi: isolate }` — the run is ISOLATED, so
 * it neither takes its ordering from the Arabic around it nor perturbs it.
 * Isolation is the half that a `direction: ltr` CSS class would miss, and it is
 * the half that matters for a Latin identifier sitting mid-sentence.
 *
 * Two deliberate non-choices:
 *
 * - **An inline code span takes `ltr`, not `auto`.** It was `auto` for one round,
 *   on the theory that a short span is safe for first-strong-character detection
 *   and an author writing `` `مرحبا` `` means Arabic. But `MarkdownContent`
 *   already sets `direction: ltr` on every `code`, so the attribute said
 *   `auto` while the rendering was `ltr` — a lie in the markup that the codex
 *   review reproduced. The CSS is the policy and `code` is left-to-right; the
 *   attribute now agrees with it, and still earns its place by adding the
 *   `unicode-bidi: isolate` a `direction` declaration cannot express on its own
 *   and by travelling with the HTML into contexts that stylesheet does not
 *   reach.
 * - **Rendered math is NOT given a `dir` here, and that is a correction.** KaTeX
 *   lays an expression out as nested inline-BLOCK groups whose visual order
 *   reverses under an RTL base, so `a = b + c` displays as `c + b = a` — silently,
 *   since every glyph is still there. This file carried `dir="ltr"` on the math
 *   wrappers for that reason, but  landed the same rule as CSS
 *   (`globals.css`: `.markdown-content.katex/.katex-display/.math` get
 *   `direction: ltr; unicode-bidi: isolate`), which reaches every context this
 *   HTML is rendered in — `MarkdownContent` is its only renderer and it always
 *   supplies that class. The attribute was therefore redundant, and an
 *   un-assertable claim that looks load-bearing is the shape this PR criticised
 *   elsewhere, so it is gone. The BEHAVIOUR is still pinned, by the math ordering
 *   assertion in `article-direction.spec.ts` — which now tests that CSS rule.
 * - **Nothing here touches ordinary prose blocks.** A `<p>` inherits the
 *   article's stated direction, which is the correct base for text written in
 *   that language even when it opens with "Zcash". Per-block `auto` would get
 *   that paragraph backwards, which is why this is a targeted set of overrides
 *   rather than `dir="auto"` sprayed over every block.
 */
const CODE_DIR = ' dir="ltr"';

/**
 * Escape the text of an inline code span exactly as marked's own `codespan`
 * renderer does (`escape(text, true)`, i.e. `[&<>"']`).
 *
 * Overriding `codespan` to add `dir` means taking over its escaping, and the
 * token's `text` is the author's raw source. Matching marked character for
 * character keeps the override a pure attribute addition — `escapeHtml` above
 * leaves `"` and `'` alone, which is safe in text content but would make the
 * output differ from the library's for no reason.
 */
function escapeCodeSpan(content: string) {
  return content
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * A link whose visible text IS its destination — what an autolink, a bare URL
 * and `[https://x](https://x)` all produce.
 *
 * Such text is a URL rather than language, so it takes `dir="ltr"` and an
 * isolate. A link whose text is prose does not: `[الصفحة الرئيسية](/)` is
 * Arabic and must run right-to-left like the sentence it sits in. Deciding this
 * from the TEXT and not from the href is the point — every link has an LTR
 * href, and only some have LTR text.
 */
function isUrlLikeLinkText(text: string) {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|tel:|www\.)/i.test(trimmed);
}

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Bash",
  shell: "Shell",
  sh: "Shell",
  zsh: "Zsh",
  js: "JavaScript",
  jsx: "JSX",
  ts: "TypeScript",
  tsx: "TSX",
  json: "JSON",
  yml: "YAML",
  md: "Markdown",
  py: "Python",
  rb: "Ruby",
  rs: "Rust",
  csharp: "C#",
  cpp: "C++",
  objc: "Objective-C",
  plaintext: "Plain text",
  text: "Plain text",
};

function renderMath(text: string, displayMode: boolean) {
  return katex.renderToString(text, {
    displayMode,
    output: "html",
    strict: "ignore",
    throwOnError: false,
  });
}

function escapeHtml(content: string) {
  return content
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Escape a value for interpolation into an HTML attribute.
 *
 * `&` MUST stay first — escaping it after the others would double-escape the
 * `&` in the entities they produce.
 *
 * `'` is escaped even though every emitter in this file uses double quotes
 *. The name of this function promises quote-safety, not double-quote
 * safety, and the day someone writes a single-quoted template here is the day
 * the missing `&;` becomes a live attribute breakout — the same shape as
 *, found by an audit rather than an incident. Two characters of cost.
 * The backtick is escaped for the same reason: old IE parsed `` ` `` as an
 * attribute delimiter. Almost certainly moot, equally cheap.
 *
 * Exported for tests only. Its effect is INVISIBLE in `processMarkdown` output:
 * the sanitizer re-parses the HTML and the serializer only re-encodes `&` and
 * `"` in an attribute value, so a correctly escaped `&;` comes back out as a
 * literal `'`. What this function protects is the parse in between — assert on
 * it directly rather than looking for entities in the final string.
 */
export function escapeHtmlAttribute(content?: string | null) {
  return String(content ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("`", "&#96;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function getApiUploadUrl(path: string) {
  return firstPartyUploadSrc(path);
}

function rewriteFree2zUploadUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  // First-party upload domains, from the one list `first-party-embed.ts`
  // owns  -- this used to be a second regexp. Only the PATH of a match
  // is kept, so the result is always our own origin.
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    !isFirstPartyUploadDomain(parsed.hostname) ||
    !parsed.pathname.startsWith("/uploadz/")
  ) {
    return url;
  }

  return getApiUploadUrl(`${parsed.pathname}${parsed.search}${parsed.hash}`);
}

/**
 * Per-render options, set for the duration of one synchronous `marked()`
 * call. `marked` is configured once at module scope and its renderers take
 * only the token, so there is no argument to thread this through; JavaScript
 * is single-threaded and `renderMarkdown` never awaits between setting and
 * clearing, so no two renders can observe each other's options.
 */
let activeRenderOptions: MarkdownRenderOptions | null = null;

export type MarkdownRenderOptions = {
  /**
   * `uploadPathKey(...)` -> poster URL, from `buildVideoPosterMap(article.media)`.
   * Absent for every caller that has no media list; the renderer then emits
   * exactly the markup it always did.
   */
  videoPosters?: Record<string, string>;
  /**
   * zPage/converse content cards for this render ( part 2), resolved by
   * the page's server loader with the READER's credentials
   * (`$lib/server/first-party-embed-cards.ts`) and keyed by
   * `firstPartyContentKey`. Absent — every caller without a loader — means
   * every content embed renders as a neutral link card.
   */
  firstPartyCards?: FirstPartyCardMap;
};

// The distinct API calls (`firstPartyFetchKey`) this render's content embeds
// have needed so far, in document order. Reset per render alongside `activeRenderOptions`, and the reason the
// renderer enforces `MAX_FIRST_PARTY_CARDS` itself rather than trusting the
// map it was handed: a card past the cap renders neutral even if one exists.
let activeFetchKeys: string[] = [];

function lookupVideoPoster(url: string): string | null {
  const posters = activeRenderOptions?.videoPosters;
  if (!posters) return null;
  const key = uploadPathKey(url);
  if (!key) return null;
  const poster = posters[key];
  // Validate at the sink, not only at the source: this string is about to
  // become a live `poster=` URL the browser fetches, and the sanitizer does
  // not apply its URI policy to `data-*`.
  return poster ? getSafeMediaUrl(poster) : null;
}

function renderVideoEmbed(url: string) {
  // An absolute media URL cannot be classified as same-origin during SSR,
  // because the renderer deliberately has no request/page origin. Keep it in
  // an inert data attribute until MarkdownContent can compare it with the
  // browser's real origin and either mount it directly or route it through the
  // existing ExternalEmbed consent gate. This is stronger than
  // `preload="none"`: there is no live `src`/`source src` for a browser to
  // fetch before consent.
  //
  // A validated root-relative upload is same-origin by construction and can
  // keep its server-rendered player. That preserves the existing first-frame
  // and no-JavaScript behaviour for the production `/uploadz/...` path.
  // The poster frame, when the API told us one exists for this upload
  //. Without it an unplayed video is a blank rectangle for the
  // reader and has no `thumbnailUrl` for a crawler. `null` is the normal
  // answer for a video whose poster has not been generated, and a missing
  // `poster` attribute is the correct rendering of that -- never a
  // placeholder image.
  const poster = lookupVideoPoster(url);

  if (isThirdPartyMediaUrl(url, null)) {
    const posterAttr = poster
      ? ` data-video-poster="${escapeHtmlAttribute(poster)}"`
      : "";
    return `<div class="video-embed-placeholder" data-video-url="${escapeHtmlAttribute(url)}"${posterAttr}></div>`;
  }

  const extension = /\.(mp4|m4v|webm|mov|qt)(?:[?#].*)?$/i
    .exec(url)?.[1]
    .toLowerCase();
  const mimeType =
    extension === "webm"
      ? "video/webm"
      : extension === "mov" || extension === "qt"
        ? "video/quicktime"
        : "video/mp4";
  const posterAttr = poster ? ` poster="${escapeHtmlAttribute(poster)}"` : "";
  return `<video controls preload="metadata" class="markdown-video"${posterAttr}>
    <source src="${escapeHtmlAttribute(url)}" type="${mimeType}">
    <span data-markdown-video-fallback></span>
  </video>`;
}

function renderExternalEmbedPlaceholder(url: string) {
  return `<div class="external-embed-placeholder" data-embed-url="${escapeHtmlAttribute(url)}"></div>`;
}

function renderAudioEmbed(url: string) {
  return `<div class="audio-embed-placeholder" data-audio-url="${escapeHtmlAttribute(url)}"></div>`;
}

// Article images are always below the hero, so they get the deferred-loading
// hints. We deliberately serve the URL the author wrote and nothing else.
//
// Do NOT be tempted to rewrite `<base>.png` -> `<base>.webp` here: that path is
// the LEGACY thumbnail, encoded at quality=50 for avatars and cards
// (py/dj/apps/uploads/image_utils.py), so it is a quality regression at article
// display size. The real responsive ladder is `<base>_w{width}.webp`
// (ImageVariant, py/dj/apps/uploads/tasks.py), whose URLs come back from Django
// storage and are NOT derivable from the original name — storage uniquifies on
// collision, and thumbnailing is skipped entirely for animated or oversized
// images. Emitting a real srcset needs GenericFile.variant_url()/get_thumbnail()
// from the API, which this string-in/string-out renderer has no access to.
// `sizes` without a `srcset` is likewise a no-op, so it is not emitted either.
function renderArticleImage(
  url: string,
  alt: string,
  titleAttr = "",
  extraClass = "",
) {
  const classAttr = extraClass ? ` class="${extraClass}"` : "";
  return `<img src="${escapeHtmlAttribute(url)}" alt="${escapeHtmlAttribute(alt)}"${titleAttr}${classAttr} loading="lazy" decoding="async" fetchpriority="low" />`;
}

/**
 * A first-party `::embed[…]`: our own upload, rendered natively; a
 * zPage or converse thread, rendered as a text content card (or its neutral
 * link card); any other first-party route, rendered as a plain link. Never a
 * consent card, never Iframely, never an iframe.
 *
 * Media keeps the sinks it always had (`renderVideoEmbed`, the audio
 * placeholder, `renderArticleImage`). A PDF or any other file is a link card:
 * uploads that are not image/video/audio are served `Content-Disposition:
 * attachment` (k8s/free2z/nginx.conf), so a frame of one would download
 * rather than render — and making it render inline would put author-supplied
 * bytes in a same-origin document, the  stored-XSS shape. `rel="external"`
 * tells the SvelteKit router this is a document load, not a client route.
 */
function renderFirstPartyEmbed(embed: FirstPartyEmbed) {
  if (!("path" in embed)) {
    if (embed.kind === "page") return renderFirstPartyPageLink(embed.href);
    return renderFirstPartyContentEmbed(embed);
  }

  const src = getApiUploadUrl(embed.path);
  if (embed.kind === "audio") return renderAudioEmbed(src);
  if (embed.kind === "video") return renderVideoEmbed(src);
  if (embed.kind === "image") {
    return renderArticleImage(src, "", "", "markdown-embed-image");
  }

  const badge = firstPartyFileBadge(embed.name);
  return `<div class="first-party-embed first-party-embed-${embed.kind}"><a class="first-party-embed-card" href="${escapeHtmlAttribute(src)}" rel="external"><span class="first-party-embed-kind"${CODE_DIR}>${escapeHtml(badge)}</span><span class="first-party-embed-name" dir="auto">${escapeHtml(embed.name)}</span></a></div>`;
}

/**
 * Any other first-party route: a plain link. The label is the WHOLE
 * destination — host, path, query and fragment — because the query is where
 * a redirect route keeps its target (`/login?next=…`), and a label that stops
 * at the path would show a reader one place while the link goes to another.
 */
function renderFirstPartyPageLink(href: string) {
  const parsed = new URL(href);
  const label = `${parsed.host}${parsed.pathname === "/" && !parsed.search && !parsed.hash ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
  return `<div class="first-party-embed first-party-embed-page"><a class="first-party-embed-card" href="${escapeHtmlAttribute(href)}"><span class="first-party-embed-name"${CODE_DIR}>${escapeHtml(label)}</span></a></div>`;
}

/**
 * A zPage or converse embed ( part 2): a content card when the page's
 * loader resolved one for THIS reader and it is within the per-render cap,
 * otherwise the neutral link card. The neutral card is one markup for every
 * reason there is no card — not found, draft, subscriber-only, deactivated,
 * deleted, over the cap, timed out, another environment's host — so the
 * difference between them is never visible in an embed.
 *
 * Both link to a path WE built, never the author's URL: a neutral card to the
 * shape the embed was classified as, on the host the author named; a content
 * card to the canonical path from the API's own answer. Of the author's query
 * and fragment only a normalized `?lang=` and a plain anchor survive
 * (`firstPartyContentSelectors`), and the label shows exactly the resulting
 * destination. A card is text only; nothing from the API is rendered as HTML.
 */
function renderFirstPartyContentEmbed(embed: FirstPartyContentEmbed) {
  const path = firstPartyContentPath(embed);
  const host = firstPartyContentHost(embed);
  const { suffix } = firstPartyContentSelectors(embed);

  // A card exists only if this page's loader resolved one for THIS reader, on
  // THIS deployment's host (the key carries the host). The renderer still
  // caps how many distinct cards one render shows, whatever it was handed.
  const key = firstPartyContentKey(embed);
  const candidate = activeRenderOptions?.firstPartyCards?.[key];
  if (candidate !== undefined) {
    const fetchKey = firstPartyFetchKey(embed);
    if (!activeFetchKeys.includes(fetchKey)) activeFetchKeys.push(fetchKey);
    const withinCap = activeFetchKeys.indexOf(fetchKey) < MAX_FIRST_PARTY_CARDS;
    const card = withinCap ? usableFirstPartyCard(embed, candidate) : null;
    if (card) {
      // Root-relative: the card was resolved for the host being read.
      const href = `${card.href}${suffix}`;
      const author = card.author
        ? `<span class="first-party-embed-author"${CODE_DIR}>@${escapeHtml(card.author)}</span>`
        : "";
      const excerpt = card.excerpt
        ? `<span class="first-party-embed-excerpt" dir="auto">${escapeHtml(card.excerpt)}</span>`
        : "";
      return `<div class="first-party-embed first-party-embed-${embed.kind} first-party-embed-resolved"><a class="first-party-embed-card first-party-embed-content-card" href="${escapeHtmlAttribute(href)}"><span class="first-party-embed-body"><span class="first-party-embed-title" dir="auto">${escapeHtml(card.title)}</span>${excerpt}<span class="first-party-embed-meta">${author}<span class="first-party-embed-name"${CODE_DIR}>${escapeHtml(`${host}${href}`)}</span></span></span></a></div>`;
    }
  }

  // The neutral card: an absolute link to the host the author named, so an
  // embed of another environment's URL still goes there.
  const href = `https://${host}${path}${suffix}`;
  return `<div class="first-party-embed first-party-embed-${embed.kind}"><a class="first-party-embed-card" href="${escapeHtmlAttribute(href)}"><span class="first-party-embed-name"${CODE_DIR}>${escapeHtml(`${host}${path}${suffix}`)}</span></a></div>`;
}

function renderHttpEmbed(url: string) {
  // Third-party only: first-party URLs were classified before this point.
  if (AUDIO_EXTENSION_PATTERN.test(url)) {
    return renderAudioEmbed(url);
  }

  if (VIDEO_EXTENSION_PATTERN.test(url)) {
    return renderVideoEmbed(url);
  }

  return renderExternalEmbedPlaceholder(url);
}

function renderDirective(token: DirectiveToken) {
  const value = token.value.trim();
  if (!value) return escapeHtml(token.raw);

  let rendered: string;
  const firstParty =
    token.name === "qrcode" ? null : classifyFirstPartyEmbed(value);
  if (token.name === "qrcode") {
    rendered = `<div class="qrcode-embed" data-qr-value="${escapeHtmlAttribute(value)}"></div>`;
  } else if (firstParty) {
    rendered = renderFirstPartyEmbed(firstParty);
  } else if (value.startsWith("/")) {
    // A root-relative value that is not an allow-listed upload shape
    // (`/uploadz/../logout`, `/uploadz/private/…`, `/alice/post`). It was
    // never a valid embed target; show the directive as text.
    rendered = escapeHtml(token.raw);
  } else {
    const safeUrl = getSafeHttpUrl(value);
    rendered = safeUrl ? renderHttpEmbed(safeUrl) : escapeHtml(token.raw);
  }

  return token.block ? `${rendered}\n` : rendered;
}

function parseCodeInfo(info = "", lineCount = 0) {
  const language = info.trim().split(/\s+/)[0]?.toLowerCase() || "";
  const highlightedLines = new Set<number>();
  const rangeMatch = /\{([^}]+)\}/.exec(info);

  for (const part of rangeMatch?.[1]?.split(",") || []) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!range) continue;
    const start = Number(range[1]);
    const end = Number(range[2] || range[1]);
    const boundedStart = Math.max(1, start);
    const boundedEnd = Math.min(lineCount, end);
    for (let line = boundedStart; line <= boundedEnd; line += 1) {
      highlightedLines.add(line);
    }
  }

  return {
    language,
    highlightedLines,
    showLineNumbers: /(?:^|\s)showLineNumbers(?:\s|$)/i.test(info),
  };
}

function splitHighlightedCodeIntoLines(html: string) {
  const lines = [""];
  const openSpans: string[] = [];
  const tokens = html.split(/(<span\b[^>]*>|<\/span>|\n)/g);

  for (const token of tokens) {
    if (token === "\n") {
      lines[lines.length - 1] += "</span>".repeat(openSpans.length);
      lines.push(openSpans.join(""));
    } else if (token.startsWith("<span")) {
      openSpans.push(token);
      lines[lines.length - 1] += token;
    } else if (token === "</span>") {
      openSpans.pop();
      lines[lines.length - 1] += token;
    } else {
      lines[lines.length - 1] += token;
    }
  }

  return lines;
}

function renderCodeBlock(code: string, info = "") {
  const {
    language: requested,
    highlightedLines,
    showLineNumbers,
  } = parseCodeInfo(info, code.split("\n").length);
  const language =
    requested && hljs.getLanguage(requested) ? requested : "plaintext";
  const safeLanguage = language.replace(/[^a-z0-9_-]/gi, "");

  if (requested === "mermaid") {
    return `<pre${CODE_DIR}><code class="language-mermaid">${escapeHtml(code)}</code></pre>\n`;
  }

  const highlightedCode =
    language === "plaintext"
      ? escapeHtml(code)
      : hljs.highlight(code, { language }).value;
  const highlighted = splitHighlightedCodeIntoLines(highlightedCode)
    .map((html, index) => {
      const lineNumber = index + 1;
      const highlightClass = highlightedLines.has(lineNumber)
        ? " code-line-highlighted"
        : "";
      return `<span class="code-line${highlightClass}">${html || " "}</span>`;
    })
    .join("");
  const lineNumberClass = showLineNumbers ? " show-line-numbers" : "";

  return `<pre${CODE_DIR}><code class="hljs language-${safeLanguage}${lineNumberClass}">${highlighted}</code></pre>\n`;
}

function normalizeF2zFootnotes(content: string) {
  const lines = content.split("\n");
  const normalized: string[] = [];
  let fenceMarker: { character: string; length: number } | null = null;

  for (const line of lines) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence && !fenceMarker) {
      const marker = fence[1];
      const suffix = fence[2];
      if (marker[0] !== "`" || !suffix.includes("`")) {
        fenceMarker = { character: marker[0], length: marker.length };
      }
    } else if (fence && fenceMarker) {
      const marker = fence[1];
      if (
        marker[0] === fenceMarker.character &&
        marker.length >= fenceMarker.length &&
        !fence[2].trim()
      ) {
        fenceMarker = null;
      }
    }

    // The reference zpage places its definition directly after the reference.
    // marked-footnote follows CommonMark block boundaries, so make that common
    // classic-f2z shape explicit without changing examples inside code fences.
    if (
      !fenceMarker &&
      /^ {0,3}\[\^[^\]]+\]:/.test(line) &&
      normalized.at(-1)?.trim()
    ) {
      normalized.push("");
    }

    normalized.push(line);
  }

  return normalized.join("\n");
}

function stripLeadingFrontmatter(content: string) {
  const match =
    /^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(
      content,
    );
  return match ? content.slice(match[0].length) : content;
}

// The `::embed[…]` / `::iframe[…]` / `::qrcode[…]` block tokenizer, shared by
// the renderer and by `collectFirstPartyContentEmbeds` so both read exactly the
// same directives.
const blockDirectiveTokenizer: TokenizerExtension = {
  name: "blockDirective",
  level: "block",
  tokenizer(src) {
    const match =
      /^ {0,3}::(embed|iframe|qrcode)\[([^\]\n]+)\][ \t]*(?:\n|$)/i.exec(src);
    if (!match) return undefined;
    return {
      type: "blockDirective",
      raw: match[0],
      name: match[1].toLowerCase(),
      value: match[2],
      block: true,
    } as DirectiveToken;
  },
};

// `$$ … $$` / `\[ … \]` display math. Shared with the directive collector for
// the same reason as the directive tokenizer: a `::embed[]` line inside a math
// block is math, not an embed, and the collector must agree (codex review).
const blockMathTokenizer: TokenizerExtension = {
  name: "blockMath",
  level: "block",
  tokenizer(src) {
    const rules = [
      /^(?: {0,3})\$\$[ \t]*\n([\s\S]+?)\n\$\$[ \t]*(?:\n|$)/,
      /^(?: {0,3})\\\[[ \t]*\n([\s\S]+?)\n\\\][ \t]*(?:\n|$)/,
      /^(?: {0,3})\\\[([^\n]+?)\\\][ \t]*(?:\n|$)/,
    ];

    for (const rule of rules) {
      const match = rule.exec(src);
      if (!match) {
        continue;
      }

      return {
        type: "blockMath",
        raw: match[0],
        text: match[1] ?? "",
      } satisfies MathToken;
    }

    return undefined;
  },
};

// A SEPARATE marked instance for collecting directives. Lexing on the global
// instance would run marked-footnote's and gfm-heading-id's stateful
// extensions outside a render (without the `preprocess` hooks that reset
// them), and the next real render would inherit that state.
let directiveLexer: Marked | null = null;
function getDirectiveLexer() {
  if (!directiveLexer) {
    directiveLexer = new Marked({ breaks: true, gfm: true });
    directiveLexer.use({
      extensions: [blockDirectiveTokenizer, blockMathTokenizer],
    });
  }
  return directiveLexer;
}

function configureMarkdown() {
  if (markdownConfigured) {
    return;
  }

  marked.setOptions({
    breaks: true,
    gfm: true,
  });

  const renderer = new marked.Renderer();

  renderer.code = function ({ text, lang }) {
    return renderCodeBlock(text, lang || "");
  };

  // An inline code span states its direction and isolates itself.
  // marked's default emits a bare `<code>`, which in Arabic prose takes the
  // paragraph's RTL base and reorders `--flag=value` around its neutral
  // characters.
  renderer.codespan = function ({ text }) {
    return `<code${CODE_DIR}>${escapeCodeSpan(text)}</code>`;
  };

  // Match classic react-markdown behavior: author-supplied raw HTML is shown
  // as text, not interpreted as DOM. Generated f2z directive HTML is emitted
  // by extension renderers and is unaffected by this renderer.
  renderer.html = function ({ text }) {
    return escapeHtml(text);
  };

  renderer.image = function ({ href, title, text }) {
    if (href && href.startsWith("/uploadz/")) {
      href = getApiUploadUrl(href);
    } else if (href) {
      href = rewriteFree2zUploadUrl(href);
    }

    const titleAttr = title ? ` title="${escapeHtmlAttribute(title)}"` : "";
    return renderArticleImage(href, text, titleAttr);
  };

  // OFF-SITE author destinations open in a fresh browsing context; same-origin
  // ones do not. The SSR anchor carries target/rel so the rule holds before
  // hydration and without JavaScript. Non-HTTP schemes (`mailto:`, `tel:`)
  // fail HTTP parsing and render as plain anchors the browser handles
  // natively, and anchors the renderer generates itself (heading permalinks,
  // footnote refs/backrefs) never route through here at all.
  //
  // The decision is made from the parsed URL, never from the tag text: a
  // destination like `https://evil.test/pwn#data-footnote-ref` still parses as
  // an off-site author link, so hydration's delegated outbound policy always
  // sees it. SSR has no request context, so "same origin" resolves against the
  // canonical site origin -- the only base identical between server render and
  // hydration.
  //
  // KNOWN LIMIT, on non-canonical hosts only (codex review). RELATIVE
  // destinations -- `#frag`, `/path`, `?query`, which is what authors actually
  // write and what  is about -- resolve same-origin against ANY base, so
  // they are correct everywhere. An ABSOLUTE author link to the host being
  // read is only recognized as internal when that host IS
  // `PUBLIC_CANONICAL_BASE_URL`; on stage/test/`new.`, where the variable is
  // not set per environment, such a link is classified external and still
  // opens a new tab. That is the behaviour EVERY link had before this change,
  // so it is a narrower version of the old bug rather than a new one.
  //
  // Do NOT "fix" it by setting PUBLIC_CANONICAL_BASE_URL per environment,
  // which is the obvious remedy and the wrong one. That variable is not a
  // link-target knob: it also feeds the canonical `<link>` (SeoHead), the
  // sitemaps, robots.txt, and every share URL. Its fallback makes stage, test
  // and `new.` advertise the PRODUCTION origin on purpose -- pointing it at
  // themselves would have them declare themselves canonical and serve their
  // own sitemaps, which is an SEO problem far worse than a stray new tab on a
  // host only staff visit.
  //
  // Reconciling against `window.location` at hydration was tried and
  // reverted: with the current browser fixtures there is no way to prove the
  // reconciliation runs (their destinations are root-relative, and a link
  // appended after the enhancement pass is never visited), and untested DOM
  // mutation on every markdown render is the worse trade. If this ever needs
  // closing, it wants its own origin signal, not an overloaded one.
  //
  // RECONCILING  WITH, because required behaviour 1 says the
  // opposite in as many words ("including same-origin links") and this is a
  // deliberate departure, not an oversight:
  //
  //   *  exists to RESTORE the classic UI's protection, and the classic
  //     `MLink` it cites set `target="_blank"` "for external links" only.
  //     Requirement 1 generalized past the behaviour it was restoring.
  //   * The safety boundary is the OFF-SITE WARNING, and same-origin links are
  //     already on the non-warned side of it by requirement 6. Whether they
  //     also open a new tab is therefore UX, not security -- nothing about the
  //     warning, its parsed destination, or its trust keys changes here.
  //   * The result was plainly broken: `[jump](#some-heading)` opened a second
  //     tab of the page you were already reading, so every in-page table of
  //     contents was unusable, and `[other](/alice/other-article)` left the
  //     SvelteKit router for a full document load (filed against
  //     after it merged).
  //   * Requirement 2 (renderer-generated same-document anchors stay local) is
  //     unaffected, and requirement 5 (trusted destinations still always open
  //     in a new tab) is about external destinations, which are unchanged.
  //
  // `rel` goes with `target`: `noopener` is meaningless without one, and
  // `noreferrer` on an internal navigation only strips our own Referer.
  renderer.link = function ({ href, title, tokens }) {
    const body = this.parser.parseInline(tokens);
    const titleAttr = title ? ` title="${escapeHtmlAttribute(title)}"` : "";
    const destination = parseOutboundHttpUrl(href ?? "", SITE_ORIGIN);
    // Decided from the link's own TEXT, not its href. A bare URL is a
    // URL in any language and takes an LTR isolate; `[الرئيسية](/)` is Arabic
    // and must run with the sentence around it.
    const dirAttr = isUrlLikeLinkText(
      this.parser.parseInline(tokens, this.parser.textRenderer),
    )
      ? CODE_DIR
      : "";

    if (!destination) {
      return `<a href="${escapeHtmlAttribute(href)}"${dirAttr}${titleAttr}>${body}</a>`;
    }

    // The marker and class stay on same-origin links too. They are what the
    // hydrated handler uses to find an author link at all, including its
    // point-of-use guard against a disallowed scheme in pre-rendered HTML;
    // dropping them here would silently take internal links out of that pass.
    const marker =
      ' class="markdown-author-link" data-markdown-author-link="true"';
    const newTab = destination.isExternal
      ? ' target="_blank" rel="noopener noreferrer"'
      : "";

    return `<a href="${escapeHtmlAttribute(href)}"${marker}${dirAttr}${newTab}${titleAttr}>${body}</a>`;
  };

  marked.use({
    extensions: [
      {
        ...blockDirectiveTokenizer,
        renderer(token) {
          return renderDirective(token as DirectiveToken);
        },
      },
      {
        ...blockMathTokenizer,
        renderer(token) {
          return `<div class="math math-block">${renderMath(
            (token as MathToken).text,
            true,
          )}</div>`;
        },
      },
      {
        name: "inlineMath",
        level: "inline",
        start(src) {
          const match = /(?:\$\$|\\\()/.exec(src);
          return match?.index;
        },
        tokenizer(src) {
          const dollarMatch =
            /^\$\$((?:\\.|[^\\$\n]|\$(?!\$))+?)\$\$(?!\$)/.exec(src);
          if (dollarMatch) {
            const text = dollarMatch[1] ?? "";
            if (text.trim() === text && text.length > 0) {
              return {
                type: "inlineMath",
                raw: dollarMatch[0],
                text,
              } satisfies MathToken;
            }
          }

          const parenMatch = /^\\\(((?:\\.|[^\\\n])+?)\\\)/.exec(src);
          if (parenMatch) {
            return {
              type: "inlineMath",
              raw: parenMatch[0],
              text: parenMatch[1] ?? "",
            } satisfies MathToken;
          }

          return undefined;
        },
        renderer(token) {
          return `<span class="math math-inline">${renderMath(
            (token as MathToken).text,
            false,
          )}</span>`;
        },
      },
    ],
    renderer,
  });

  // SECURITY: marked-footnote builds the backref link as
  //   `aria-label="${backRefLabel.replace("{0}", label)}"`
  // with NO escaping of `label` (marked-footnote@1.4.0 dist/index.js). The
  // label is author-controlled, so the default template "Back to reference {0}"
  // lets a label containing `">` close the attribute and the tag and emit
  // arbitrary markup — `<style>` and `style=` survive DOMPurify, giving
  // page-wide CSS defacement, attribute exfiltration and full-viewport phishing
  // overlays on a free2z.cash page. Passing a constant with no `{0}` removes the
  // interpolation entirely, which is the only escape-proof option the library
  // exposes.
  //
  // Trade-off: the backref no longer names which reference it returns to. The
  // library gives us one global template, not a per-footnote hook, so there is
  // no way to interpolate a *sanitized* value through this option. The visible
  // `↩`/`↩²` markers and the enclosing `<li>` still convey position. Do not
  // reintroduce `{0}` without first proving the label is escaped.
  marked.use(markedFootnote({ backRefLabel: "Back to reference" }));
  marked.use(gfmHeadingId());

  markdownConfigured = true;
}

/**
 * marked-footnote emits its own footnote anchors and never routes them through
 * `renderer.link`, so generated refs/backrefs carry no target/rel/class to
 * begin with. A previous string-pass normalizer that stripped attributes from
 * any `<a>` whose tag TEXT contained `data-footnote-ref`/`data-footnote-backref`
 * was removed: it matched author-controlled href/title content, so a
 * destination like `https://evil.test/pwn#data-footnote-ref` silently disarmed
 * the outbound-link policy for a genuinely external link. Hydration-side
 * defense lives in MarkdownContent's DOM pass over the real attribute selector
 * `a[data-footnote-ref], a[data-footnote-backref]`, which is not spoofable this
 * way; `renderer.link` itself now decides target/rel from the parsed
 * destination, so even a future plugin version routing footnote tokens through
 * it would classify same-document anchors as local.
 */
function renderMarkdown(
  content: string,
  options?: MarkdownRenderOptions,
): string {
  if (!content) return "";

  activeRenderOptions = options ?? null;
  activeFetchKeys = [];
  try {
    configureMarkdown();

    const result = marked(
      normalizeF2zFootnotes(stripLeadingFrontmatter(content)),
    );

    if (typeof result === "string") {
      return sanitizeMarkdownHtml(result);
    }

    console.warn("Async markdown processing not yet supported");
    return sanitizeMarkdownHtml(content);
  } catch (error) {
    console.error("Error processing markdown:", error);
    return escapeHtml(content);
  } finally {
    // `finally`, so a throwing render cannot leak one page's poster map
    // into the next one.
    activeRenderOptions = null;
    activeFetchKeys = [];
  }
}

/**
 * The zPage/converse embeds in `content` that may have a card, in document
 * order, each key once, needing at most `MAX_FIRST_PARTY_CARDS` distinct API
 * calls — exactly the set the renderer will look up, so the loader never
 * fetches a card it would not show.
 *
 * KNOWN DISAGREEMENTS with the renderer, all fail-safe (an embed the
 * collector misses renders as the neutral link card; nothing is ever fetched
 * for something the renderer does not show as an embed card). The collector
 * lexes with only the directive and math tokenizers, and a `::embed[]` in
 * these places is not collected, or is not rendered as a directive:
 *
 *  - inside a GFM table cell (the directive is block-level; cells are inline);
 *  - on an ATX heading line (`##::embed[…]` is a heading, not a directive);
 *  - inside a raw HTML block (`<div>` … `</div>`), which marked passes through;
 *  - on a lazy paragraph-continuation line (a directive directly under a
 *    paragraph line with no blank line may be read as part of the paragraph);
 *  - inside a footnote definition (`[^1]:::embed[…]`): the renderer's
 *    marked-footnote extension renders it, but that extension is stateful and
 *    must not run outside a render (codex R1), so it is never collected —
 *    such an embed always renders neutral.
 *
 * If one of these ever mattered, the fix is to share the renderer's
 * tokenizer for that construct with the collector (as math blocks are), not
 * to lex on the renderer's global instance. Lexes rather than renders (no highlighting, math or sanitizing), on a
 * private marked instance carrying only the renderer's own directive
 * tokenizer, so an `::embed[]` inside a code block is text here exactly as it
 * is on the page, and no stateful render extension is touched.
 */
export function collectFirstPartyContentEmbeds(
  content: string,
  host: string,
): FirstPartyContentEmbed[] {
  if (!content) return [];
  const found: FirstPartyContentEmbed[] = [];
  const seen = new Set<string>();
  const fetches = new Set<string>();
  try {
    const lexer = getDirectiveLexer();
    const tokens = lexer.lexer(stripLeadingFrontmatter(content));
    lexer.walkTokens(tokens, (token) => {
      if (token.type !== "blockDirective") return;
      const directive = token as unknown as DirectiveToken;
      if (directive.name === "qrcode") return;
      const embed = classifyFirstPartyEmbed(directive.value.trim());
      if (!embed || (embed.kind !== "zpage" && embed.kind !== "converse")) {
        return;
      }
      if (firstPartyContentHost(embed) !== host) return;
      const key = firstPartyContentKey(embed);
      if (seen.has(key)) return;
      // The cap counts API calls, not keys: several spellings of one page
      // share a slot (`firstPartyFetchKey`).
      const fetchKey = firstPartyFetchKey(embed);
      if (!fetches.has(fetchKey) && fetches.size >= MAX_FIRST_PARTY_CARDS) {
        return;
      }
      fetches.add(fetchKey);
      seen.add(key);
      found.push(embed);
    });
  } catch (error) {
    console.error("Error collecting first-party embeds:", error);
    return [];
  }
  return found;
}

export function processMarkdown(
  content: string,
  options?: MarkdownRenderOptions,
): string {
  return renderMarkdown(content, options);
}

export function getCodeLanguageInfo(languageClass = "") {
  const normalized = languageClass
    .replace(/^language-/, "")
    .replace(/^lang-/, "")
    .trim()
    .toLowerCase();

  if (!normalized) {
    return {
      requested: "",
      language: "plaintext",
      label: "Plain text",
      supported: false,
    };
  }

  const supported = Boolean(hljs.getLanguage(normalized));
  const language = supported ? normalized : "plaintext";
  const label =
    LANGUAGE_LABELS[normalized] ||
    LANGUAGE_LABELS[language] ||
    normalized
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());

  return {
    requested: normalized,
    language,
    label,
    supported,
  };
}

export function extractPlainText(content: string, maxLength = 160): string {
  if (!content) return "";

  const summaryContent = stripMediaDirectivesFromSummary(content);

  try {
    const htmlContent = processMarkdown(summaryContent)
      .replace(
        /<section\b[^>]*class="[^"]*\bfootnotes\b[^"]*"[^>]*>[\s\S]*<\/section>\s*$/i,
        "",
      )
      .replace(
        /<sup>\s*<a\b(?=[^>]*\bdata-footnote-ref\b)[^>]*>[\s\S]*?<\/a>\s*<\/sup>/gi,
        "",
      );
    const textContent = htmlContent
      .replace(/<[^>]*>/g, "")
      .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
      .replace(/&#x([\da-f]+);/gi, (_, value) =>
        String.fromCodePoint(Number.parseInt(value, 16)),
      )
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replace(/\s+/g, " ")
      .trim();

    if (maxLength && textContent.length > maxLength) {
      return textContent.substring(0, maxLength).trim() + "...";
    }

    return textContent;
  } catch (error) {
    console.error("Error extracting plain text:", error);
    return summaryContent.substring(0, maxLength) + "...";
  }
}
