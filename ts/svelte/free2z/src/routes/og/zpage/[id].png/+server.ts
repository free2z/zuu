import * as env from "$app/env/private";
import { explicitArticleLanguage } from "$lib/zpage-language.js";
import { encodeSocialPng } from "$lib/server/og-output";
import { historicRootClientKey } from "$lib/server/historic-root-admission";
import { plainSocialCardSummaryText as plainText } from "$lib/social-card-text";
import { Resvg } from "@resvg/resvg-js";
import {
  fetchCoverImage,
  selectCoverSource,
  type CoverOutcome,
  type OgFeaturedImage,
} from "$lib/server/og-image";
import {
  acquireOgRenderSlot,
  GateSaturationError,
  logOgArticleLookupLimit,
  logOgRenderRateLimit,
  tryAdmitOgArticleLookup,
  tryAdmitOgRender,
} from "$lib/server/og-render-gate";
import { wrapOgText, renderOgTextBlock } from "$lib/server/og-text";
import type { RequestHandler } from "./$types";

type OgArticle = {
  /**
   * The zPage's UUID. Required and read-only on `zPageDetailSerializer`, so
   * every real detail response carries it — which is what makes it usable as
   * the "did we actually get a zPage?" witness in `recognizeArticle`.
   */
  free2zaddr?: string;
  title?: string;
  actual_language?: string;
  description?: string;
  content?: string;
  category?: string;
  creator?: { username?: string };
  featured_image?: OgFeaturedImage;
};

/**
 * Is this a zPage, or merely a 200?
 *
 * `absent` — "this page genuinely has no featured image" — is a SETTLED
 * answer and is deliberately not even logged. It is still a settled card and
 * uses the short shared-cache TTL; an authorization change can therefore take
 * up to 60 seconds to reach a cache that already holds it. But every part of
 * the content decision rested on one unchecked
 * assumption: that the JSON we parsed was the article. Nothing verified it.
 * `payload.featured_image` is `undefined` on
 * a real coverless zPage AND on `{}`, on `{"detail":"..."}`, on an LB or
 * service-mesh interstitial that happens to be JSON, on a truncated body that
 * still parses, and on any future response shape Django grows — and all of
 * those took the `absent` branch and returned a misleading card (
 * residual 4 of ).
 *
 * That is the same asymmetry  is about, reached from the other side: the
 * failure is trusting a payload we did not check, so the check is cheap and
 * the tie-break goes to retryable.
 *
 * `free2zaddr` is the witness because it is required and read-only on
 * `zPageDetailSerializer` (py/dj/apps/g12f/serializers), present on the
 * subscriber-only `{show_modal, page}` envelope's inner page too, and absent
 * from anything that is not a zPage detail response. It is checked for
 * PRESENCE, not for matching `params.id` — the route accepts a vanity slug as
 * well as a UUID, and a translated or redirected page can legitimately answer
 * under a different identifier.
 *
 * When it fails, the caller answers 502 rather than rendering; the reasoning
 * for refusing instead of degrading is at the call site.
 */
function recognizeArticle(payload: unknown): OgArticle | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  // A subscriber-only zPage answers 200 with `{show_modal, page}` rather than
  // the article itself (`custom_exception_handler` in
  // py/dj/apps/g12f/views/exception_handler.py). Rendering that wrapper as an
  // article yields undefined everywhere and a titleless, coverless card — and
  // gated pages are exactly the ones whose link someone is trying to sell.
  // Unwrap it. Nothing paywalled comes back: this request is deliberately
  // anonymous, so the API has already redacted `content`.
  //
  // The envelope is tried FIRST and the bare payload second, so neither shape
  // depends on the other being absent.
  for (const candidate of [record.page, record]) {
    if (!candidate || typeof candidate !== "object") continue;
    const article = candidate as OgArticle;
    if (
      typeof article.free2zaddr === "string" &&
      article.free2zaddr.trim() &&
      // `free2zaddr` alone is not enough. An envelope can carry the id it was
      // asked about while being an ANSWER rather than the article —
      // `{free2zaddr, detail: "authentication required"}` is the shape an
      // auth or redaction change would most plausibly grow, and it would pass
      // an id-only test, render the house card and take the success TTL. So
      // require the other two fields the card is actually drawn from, both
      // required on `zPageDetailSerializer`.
      //
      // PRESENCE and TYPE only, never non-emptiness: `title` may legitimately
      // be `''` (`buildSvg` has a fallback for exactly that) and a check that
      // demanded content would 502 a real page.
      typeof article.title === "string" &&
      // `creator.username` rather than just `creator`, because `{}` is what an
      // answer-shaped envelope produces and it renders as the generic
      // "Free2Z creator" byline under the success TTL. `username` is required
      // on `SimpleCreator`, so no real zPage lacks it — a bare `typeof
      // creator === 'object'` test would wave the envelope through, and
      // `typeof [] === 'object'` would wave an array through too.
      typeof (article.creator as { username?: unknown } | undefined)
        ?.username === "string"
    ) {
      return article;
    }
  }
  return null;
}

const WIDTH = 1200;
const HEIGHT = 630;

// See the deadline comment in the handler.
const ARTICLE_TIMEOUT_MS = 10_000;

// Article cards derive from two independently revocable inputs: the article
// API response and its featured upload. A 60-second CDN lifetime restores
// burst collapse while limiting this derivative's additional revocation delay
// to at most 60 seconds. Do not add stale serving: after this TTL, the next
// request must re-check current authorization.
// `?v=...` can prompt social platforms to refetch, but cannot erase their copies.
const ARTICLE_CARD_CACHE_CONTROL =
  "public, max-age=0, s-maxage=60, must-revalidate";
const ARTICLE_CARD_TRANSIENT_CACHE_CONTROL = "no-store";

function noStoreError(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(message, {
    status,
    headers: {
      "cache-control": ARTICLE_CARD_TRANSIENT_CACHE_CONTROL,
      "content-type": "text/plain; charset=utf-8",
      ...headers,
    },
  });
}

/**
 * One bare JSON line per degraded card, so the failure is countable.
 *
 * Repo pattern: `dj.apps.g12f.views.sitemap._log_sitemap_event` — GKE's
 * logging agent parses a JSON stdout line into `jsonPayload` and promotes
 * `severity`. `monitoring/log-metrics/og-card-cover-failures.json` counts
 * these. NB: that metric does nothing until `bin/apply-monitoring.sh`
 * is run against the project; committing the file is not deploying it.
 *
 * Only failures are logged — a card with a cover, and a page that has no
 * featured image at all, are both the normal case and would be pure volume.
 * Nothing user-controlled but the already-length-capped id goes in the line;
 * in particular not the cover URL.
 */
function logCoverFailure(fields: {
  outcome: "permanent" | "transient";
  reason?: string;
  status?: number;
  zpage_id: string;
}) {
  console.log(
    JSON.stringify({
      severity: fields.outcome === "transient" ? "WARNING" : "INFO",
      message:
        fields.outcome === "transient"
          ? "OG card rendered without its cover after a retryable failure."
          : "OG card rendered without its cover; the cover is unusable.",
      event: "og_card",
      ...fields,
    }),
  );
}

/**
 * One line per card REFUSED because the API's 200 was not an article.
 *
 * Deliberately a different event from `og_card`: that metric counts cards
 * rendered without their cover, and here no card is rendered at all, so
 * folding these in would corrupt it — the same split `og_gate` already uses.
 * Counted by `monitoring/log-metrics/og-article-refused.json` and paged on by
 * `monitoring/alert-policies/prod-og-article-refused.json`, which is the only
 * thing standing between a runtime API-shape change and every social card on
 * the site failing with `/healthz` green.
 *
 * `reason` is a closed set of literals, never anything derived from the
 * payload: the payload is upstream-controlled and must not reach a log line
 * (or a metric label, which would then be unbounded in cardinality).
 */
function logArticleRefused(
  reason: "article_body_not_json" | "unrecognized_article_payload",
  zpageId: string,
) {
  console.log(
    JSON.stringify({
      severity: "WARNING",
      message:
        "OG card refused: the API answered 200 with something that is not a zPage.",
      event: "og_article",
      reason,
      zpage_id: zpageId,
    }),
  );
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildSvg(article: OgArticle, cover: string | null) {
  const title = plainText(article.title, 125) || "A story on Free2Z";
  const subtitle =
    plainText(article.description || article.content, 190) ||
    "Independent publishing and direct creator support.";
  const titleLines = wrapOgText(title, cover ? 11 : 34, 3);
  const subtitleLines = wrapOgText(subtitle, cover ? 32 : 68, 2);
  const titleSize =
    titleLines.length >= 3 ? 51 : titleLines.length === 2 ? 57 : 64;
  const titleStart =
    titleLines.length === 1 ? 270 : titleLines.length === 2 ? 245 : 225;
  const author = escapeXml(
    article.creator?.username
      ? `@${article.creator.username}`
      : "Free2Z creator",
  );
  const category = escapeXml(plainText(article.category, 30) || "STORY");
  const subtitleStart = titleStart + titleLines.length * (titleSize + 9) + 30;
  const contentText = renderOgTextBlock(
    [
      ...titleLines.map((text, index) => ({
        text,
        y: titleStart + index * (titleSize + 9),
        size: titleSize,
        bold: true,
        color: "#f4f4f5",
      })),
      ...subtitleLines.map((text, index) => ({
        text,
        y: subtitleStart + index * 31,
        size: 23,
        color: "#d4d4d8",
      })),
    ],
    { x: 74, width: cover ? 426 : 1050, language: article.actual_language },
  );

  // Keep the complete artwork inside its panel. Text is shaped and fitted to
  // its own column from real glyph bounds, including non-Latin fallback fonts.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#09090b"/><stop offset="1" stop-color="#17171b"/></linearGradient>
      <linearGradient id="fallbackGlow" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#84cc16" stop-opacity=".24"/><stop offset="1" stop-color="#84cc16" stop-opacity="0"/></linearGradient>
      <pattern id="grid" width="54" height="54" patternUnits="userSpaceOnUse"><path d="M54 0H0V54" fill="none" stroke="#f4f4f5" stroke-opacity=".055"/></pattern>
      <clipPath id="frame"><rect width="1200" height="630" rx="30"/></clipPath>
      <style>.title{font-family:Arial,sans-serif;font-size:${titleSize}px;font-weight:700;fill:#f4f4f5;letter-spacing:-1.8px}.subtitle{font-family:Arial,sans-serif;font-size:23px;font-weight:400;fill:#d4d4d8}.meta{font-family:Arial,sans-serif;font-size:18px;font-weight:700;letter-spacing:1.8px}.small{font-family:Arial,sans-serif;font-size:18px;font-weight:600}</style>
    </defs>
    <g clip-path="url(#frame)">
      <rect width="1200" height="630" fill="url(#bg)"/>
      ${
        cover
          ? `<image href="${cover}" x="510" width="690" height="630" preserveAspectRatio="xMidYMid meet"/><line x1="510.5" y1="0" x2="510.5" y2="630" stroke="#f4f4f5" stroke-opacity=".12"/>`
          : `<rect x="610" width="590" height="630" fill="url(#grid)"/><circle cx="1015" cy="180" r="230" fill="url(#fallbackGlow)"/><path d="M720 520C835 450 925 475 1095 265" fill="none" stroke="#a3e635" stroke-opacity=".45" stroke-width="3" stroke-dasharray="7 12"/>`
      }
      <rect x="0" width="8" height="630" fill="#a3e635"/>
      <text x="72" y="121" font-family="Arial,sans-serif" font-size="58" font-weight="700" fill="#A3E635" letter-spacing="-2">Free2Z</text>
      <text x="75" y="170" class="meta" fill="#a3e635">${category}</text>
      ${contentText}
      <line x1="76" y1="548" x2="${cover ? 500 : 520}" y2="548" stroke="#a3e635" stroke-opacity=".48"/>
      <text x="76" y="586" class="small" fill="#f4f4f5">${author}</text>
      <text x="1124" y="586" class="small" fill="#a3e635" text-anchor="end">FREE2Z.CASH</text>
    </g>
    <rect x=".5" y=".5" width="1199" height="629" rx="29.5" fill="none" stroke="#f4f4f5" stroke-opacity=".12"/>
  </svg>`;
}

type RenderContext = {
  fetch: typeof globalThis.fetch;
  url: URL;
  setHeaders: (headers: Record<string, string>) => void;
};

export const GET: RequestHandler = async ({
  params,
  fetch,
  url,
  request,
  setHeaders,
}) => {
  const id = params.id?.trim();
  if (!id || id.length > 160) {
    return noStoreError(400, "Invalid ZPage identifier");
  }

  const apiBase = env.PRIVATE_API_BASE_URL?.replace(/\/$/, "") || url.origin;
  // `credentials: 'omit'` is load-bearing, not tidiness. The PNG below is
  // publicly cacheable, so it must never depend on who asked. SvelteKit's
  // default is `same-origin`, and `apiBase` falls back to `url.origin` when
  // PRIVATE_API_BASE_URL is unset — one bad rollout and an author previewing
  // their own subscriber-only page would hand Django a session cookie, get the
  // unredacted body back, and have up to 190 characters of it rendered into a
  // public image response. Today's `http://localhost:8080` merely happens to
  // make that impossible.
  //
  // The deadline is the same argument as COVER_FETCH_TIMEOUT_MS in
  // $lib/server/og-image: nginx abandons this route at `proxy_read_timeout
  // 30s`, so an unbounded await just leaves a pending request pinned to a
  // 512Mi pod after the caller is gone. 10s + the cover's 8s + the rasterize
  // still fits inside 30s. A blown deadline surfaces as a 504, which nginx
  // maps to @seo_unavailable — `Cache-Control: no-store`, so it cannot be
  // pinned at the edge.
  const rawLanguage = url.searchParams.get("lang");
  const language =
    rawLanguage && rawLanguage.length <= 35
      ? explicitArticleLanguage(rawLanguage)
      : null;
  if (rawLanguage !== null && (!language || language !== rawLanguage)) {
    return noStoreError(400, "Invalid content language");
  }
  const articleUrl = new URL(`${apiBase}/api/zpage/${encodeURIComponent(id)}/`);
  if (language) articleUrl.searchParams.set("lang", language);

  // Bound every Django article lookup before it reaches the shared backend.
  // The per-client bucket permits a two-request burst, then one lookup/second
  // per Svelte process; the separate aggregate bucket permits a two-request
  // burst, then two lookups per second total, with at most two fetches in
  // flight and no rate queue.
  // This stops one client spending every backend permit while retaining an
  // aggregate bound when traffic is distributed. Every cache miss reaches
  // this live permission/source read; cached cards can persist for up to 60s.
  const clientKey =
    historicRootClientKey({
      request: { headers: request?.headers },
    }) ?? "unknown";
  const lookupAdmission = tryAdmitOgArticleLookup(clientKey);
  if (!lookupAdmission.admitted) {
    logOgArticleLookupLimit(
      lookupAdmission.reason,
      lookupAdmission.retryAfterMs,
    );
    return noStoreError(503, "OG article lookup busy", {
      "retry-after": Math.max(
        1,
        Math.ceil(lookupAdmission.retryAfterMs / 1_000),
      ).toString(),
      "x-f2z-og-admission-limited": "1",
    });
  }

  let response: Response;
  try {
    response = await fetch(articleUrl.href, {
      credentials: "omit",
      signal: AbortSignal.timeout(ARTICLE_TIMEOUT_MS),
    });
  } catch {
    return noStoreError(504, "Unable to load ZPage");
  } finally {
    lookupAdmission.release();
  }
  if (!response.ok) {
    const status = response.status === 404 ? 404 : 502;
    return noStoreError(status, "Unable to load ZPage");
  }

  // The response is now admitted through two process-local bounds: the lookup
  // bucket above caps Django work, and this semaphore caps materialized article
  // bodies, covers, and SVGs at two active renders plus eight bounded waiters.
  // It runs after Django's status is known, so a genuine 404 preserves its
  // status and never occupies a render slot. Saturation is retryable and
  // no-store; nginx maps it through @seo_unavailable.
  let releaseRenderSlot: () => void;
  try {
    releaseRenderSlot = await acquireOgRenderSlot();
  } catch (cause) {
    // Abandon the unconsumed article body so its socket frees now instead of
    // at GC time; we are rejecting or rethrowing either way.
    response.body?.cancel().catch(() => {});
    if (cause instanceof GateSaturationError) {
      return noStoreError(503, "OG image renderer busy", {
        "retry-after": "1",
        "x-f2z-og-admission-limited": "1",
      });
    }
    throw cause;
  }
  try {
    return await renderZpageCard(id, response, { fetch, url, setHeaders });
  } catch {
    logRenderFailure(id);
    return noStoreError(503, "Unable to render social image");
  } finally {
    releaseRenderSlot();
  }
};

/**
 * Preserve a diagnostic event for unexpected renderer failures without
 * serializing exception messages, stack traces, or request payloads. Those
 * can contain upstream-controlled or otherwise sensitive data.
 */
function logRenderFailure(zpageId: string) {
  console.error(
    JSON.stringify({
      severity: "ERROR",
      message: "OG card rendering failed unexpectedly.",
      event: "og_render",
      reason: "render_failed",
      zpage_id: zpageId,
    }),
  );
}

async function renderZpageCard(
  id: string,
  response: Response,
  { fetch, url, setHeaders }: RenderContext,
): Promise<Response> {
  const apiBase = env.PRIVATE_API_BASE_URL?.replace(/\/$/, "") || url.origin;
  // A 200 whose body is not JSON at all is an infrastructure answer, not a
  // zPage — an LB error page, a service-mesh interstitial, a truncated body.
  // Letting `json()` throw here would surface as a SvelteKit 500, whose
  // caching contract at the edge is not one this route ever chose; 502 is the
  // same retryable answer the `!response.ok` branch above already gives, and
  // the /og/zpage nginx location maps it to @seo_unavailable (no-store).
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // Counted on the SAME metric as the unrecognized-payload refusal below,
    // with its own reason. These are one incident wearing two hats — the
    // interstitial that arrives as HTML lands here, the one that arrives as
    // JSON lands there — and a proxy that returns HTML would otherwise leave
    // `og_article_refused` at zero while every card 502s.
    logArticleRefused("article_body_not_json", id);
    return noStoreError(502, "Unable to load ZPage");
  }
  // See `recognizeArticle`: `null` means we hold a 200 that is not a zPage.
  //
  // Rejected rather than rendered, for the same reason as the non-JSON case
  // above and one more. A rendered card would have no title, author, or cover —
  // the generic house card under this page's permanent URL. That settled card
  // would use the same 60-second shared-cache TTL as other successful cards;
  // an authorization change could take up to 60s to reach an edge cache that
  // already holds it. Facebook, X and Slack keep their own copy of an unfurled
  // image and honour no origin TTL at all ( residual 3), and
  // `?v=<updated_at>` cannot bust it because the page did not change — our
  // upstream did. Returning the retryable, uncached 502 below avoids pinning
  // that known-wrong card in caches we cannot invalidate. Not rasterizing also
  // returns the gate slot and its ~30MB immediately, on the tier that heap-OOMs
  // daily.
  //
  // The fail-closed risk is the honest cost: if the API ever stops carrying
  // `free2zaddr`, every card 502s instead of degrading — and nothing else in
  // production would notice, because /healthz never exercises /og/ and no
  // container restarts. Both halves of that are covered:
  //
  // - A DECLARED shape change breaks CI. tests/og-card-failure-caching.test.mjs
  //   pins `free2zaddr` as required on the generated `ZPageDetail`, which CI
  //   regenerates from f2z.yaml, which CI regenerates from the serializers.
  // - A RUNTIME one — a proxy, an ingress error page, an envelope Django grows
  //   at request time — pages. The log line below feeds
  //   monitoring/log-metrics/og-article-refused.json and
  //   monitoring/alert-policies/prod-og-article-refused.json (ERROR, >5 in
  //   10m; steady state is exactly zero). Per  that file alerts on
  //   nothing until bin/apply-monitoring.sh is run against the project.
  //
  // What this does NOT check is that the article is THIS article: any zPage
  // passes, so an internal-cache or routing regression that answered with a
  // different page could still be shown under this URL. Raised four rounds
  // running by the adversarial review and deliberately not acted on:
  //
  // - A HARD check cannot be exact. `params.id` is resolved by
  //   `dj.apps.g12f.identifiers.resolve_zpage_pk`, which has four tiers:
  //   `free2zaddr` exact, `vanity` exact, `vanity == slugify(id)`, then
  //   `vanity__iexact`. Comparing against `free2zaddr`/`vanity` covers only
  //   the first two. Those two are every URL WE emit (`buildImage` in
  //   $lib/meta uses `article.vanity || article.free2zaddr`) — but a
  //   hand-typed or legacy link resolving through tier 3 or 4 is a page that
  //   Django resolved perfectly well, and refusing is total: no card at all.
  //   Reimplementing Django's `slugify` in TypeScript to close that gap is a
  //   parity hazard whose failure mode is, again, a card outage.
  // - A SOFT check (downgrade the TTL instead of refusing) needs a signal, and
  //   there is no honest place to put one. `og_card` means "a card rendered
  //   without its cover", which this is not; `og_article` means "no card was
  //   rendered", which this is not either, and it is the metric the pager
  //   watches — a legitimate tier-3 resolution must never page.
  // - The scenario is an internal response cache or router serving page A for
  //   page B. That is a whole-site integrity failure — every SSR page, every
  //   API read — and the social card is the wrong place to build the detector
  //   for it, at the price of a new overloaded signal on the one path that is
  //   already the most memory-constrained in the fleet.
  const article = recognizeArticle(payload);
  if (!article) {
    logArticleRefused("unrecognized_article_payload", id);
    return noStoreError(502, "Unable to load ZPage");
  }

  // This CPU budget is checked only after the response body proves this is a
  // real article, but before reading a cover or running synchronous Resvg
  // work. It is charged after each rasterization finishes, so a long render
  // cannot consume its own cooldown while blocking the event loop. Four times
  // the measured synchronous work is then reserved for ordinary SSR and
  // readiness probes. The lookup bucket above independently bounds Django.
  const admission = tryAdmitOgRender();
  if (!admission.admitted) {
    logOgRenderRateLimit(admission.retryAfterMs);
    return noStoreError(503, "OG image renderer busy", {
      "retry-after": Math.max(
        1,
        Math.ceil(admission.retryAfterMs / 1_000),
      ).toString(),
      "x-f2z-og-admission-limited": "1",
    });
  }

  const renderCpuStart = process.cpuUsage();
  try {
    const mediaBase = new URL(`${apiBase}/`);
    // The selector picks the smallest ladder rung at least 690px wide, normally
    // the 800px rung. It bounds Resvg's decode as well as the bytes held in this
    // 512Mi SSR process. Legacy thumbnail/original fallbacks are retained for
    // rows uploaded before the  ladder was generated; fetchCoverImage still
    // rejects any fallback whose decoded dimensions exceed the memory bound.
    const coverSource = selectCoverSource(article.featured_image);
    const cover = await fetchCoverImage(fetch, coverSource, mediaBase);
    let outcome: CoverOutcome = cover.outcome;
    if (outcome === "permanent" || outcome === "transient") {
      logCoverFailure({
        outcome,
        reason: cover.reason,
        status: cover.status,
        zpage_id: id,
      });
    }

    let png: Uint8Array;
    try {
      png = new Resvg(buildSvg(article, cover.dataUri), {
        fitTo: { mode: "width", value: WIDTH },
      })
        .render()
        .asPng();
    } catch {
      // Header checks cannot prove that compressed image data is intact. A
      // corrupt legacy cover must degrade to the text card, not turn the public
      // OG endpoint into a 500.
      //
      // But this catch cannot tell a corrupt cover from a rasterizer that ran
      // out of heap — and the SSR process heap-OOMs 3-7x/day in production
      //, so the OOM reading is the common one. Ambiguity resolves to
      // `transient`: a generic card for a page whose cover is fine is a temporary
      // response, so the no-store policy lets a later request try the cover again.
      outcome = "transient";
      logCoverFailure({ outcome, reason: "rasterize_failed", zpage_id: id });
      png = new Resvg(buildSvg(article, null), {
        fitTo: { mode: "width", value: WIDTH },
      })
        .render()
        .asPng();
    }

    try {
      png = await encodeSocialPng(png);
    } catch {
      return noStoreError(503, "Unable to encode social image");
    }

    setHeaders({
      "cache-control":
        outcome === "transient"
          ? ARTICLE_CARD_TRANSIENT_CACHE_CONTROL
          : ARTICLE_CARD_CACHE_CONTROL,
      "content-type": "image/png",
      "content-length": png.byteLength.toString(),
      // Which branch produced this card, so a wrong one in the wild can be
      // diagnosed from the response instead of guessed at. This does not affect
      // derivative identity and carries no reader-specific information.
      "x-og-cover": outcome,
      "x-content-type-options": "nosniff",
    });
    return new Response(Uint8Array.from(png).buffer);
  } finally {
    const renderCpu = process.cpuUsage(renderCpuStart);
    admission.complete((renderCpu.user + renderCpu.system) / 1_000);
  }
}
