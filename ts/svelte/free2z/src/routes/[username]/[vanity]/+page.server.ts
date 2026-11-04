import { error, redirect } from "@sveltejs/kit";
import * as env from "$app/env/private";
import { createAbortSignalWithTimeout } from "$lib/abort-signal.js";
import { ARTICLE_VARIANT_RETRY_TIMEOUT_MS } from "$lib/article-ssr-deadlines.js";

import { DEFAULT_LOCALE } from "$lib/locale.js";
import {
  explicitArticleLanguage,
  normalizeContentLanguage,
  resolveArticleLanguage,
  variantLanguageRetry,
} from "$lib/zpage-language.js";
import { isNullishSlug } from "$lib/zpage-slug";
import { zpageCanonicalPath } from "$lib/zpage-path";
import { loadArticleEnrichments } from "$lib/server/article-enrichment";
import { loadFirstPartyCardSeed } from "$lib/server/first-party-embed-cards";
import { logSsrError, logSsrWarning } from "$lib/server/ssr-log";
import {
  upstreamClientError,
  upstreamErrorMessage,
} from "$lib/server/upstream-status";
import type { ZPageDetail } from "$lib/api/f2z.schemas";
import type { PageServerLoad } from "./$types";

// Optional links must not hold the article stream open behind an upstream
// stall, and neither must a SECOND opinion about which language to render.
// Both numbers live in $lib/article-ssr-deadlines.js because the browser spec
// that asserts them derives its own wall-clock bound from them: a test that
// restates the literal is how that bound silently became equal to their sum
//.

type LoadFetch = Parameters<PageServerLoad>[0]["fetch"];
type GatedArticleResponse = { show_modal: boolean; page: ZPageDetail };
class ApiFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
    /** The response's raw `Retry-After`, forwarded on a 429. */
    readonly retryAfter: string | null = null,
  ) {
    super(message, options);
    this.name = "ApiFetchError";
  }
}

function buildApiUrl(
  path: string,
  params?: Record<string, string | number | undefined>,
) {
  const apiBase = env.PRIVATE_API_BASE_URL?.replace(/\/$/, "") || "";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== "")
      searchParams.set(key, String(value));
  }

  const query = searchParams.toString();
  return `${apiBase}${normalizedPath}${query ? `?${query}` : ""}`;
}

async function fetchJson<T>(
  path: string,
  cookie: string | null,
  eventFetch: LoadFetch,
  params?: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;

  try {
    response = await eventFetch(buildApiUrl(path, params), {
      headers: cookie ? { cookie } : undefined,
      signal,
    });
  } catch (cause) {
    throw new ApiFetchError(`Request failed for ${path}`, undefined, { cause });
  }

  if (!response.ok) {
    throw new ApiFetchError(
      `Request failed for ${path}: ${response.status}`,
      response.status,
      undefined,
      response.headers.get("retry-after"),
    );
  }

  return response.json();
}

export const load: PageServerLoad = async ({
  params,
  request,
  fetch,
  url,
  locals,
  setHeaders,
}) => {
  const { username, vanity } = params;
  let cookie: string | null = null;

  // A literal `null`/`undefined` segment identifies nothing. Answer
  // before anything else runs: no locale arithmetic, no `setHeaders`, and
  // above all no `GET /api/zpage/null/` — forwarding a stringified nothing to
  // the API only turns one guaranteed 404 into two, and the SSR render it
  // used to pay for is real work on a process that already OOMs under load.
  if (isNullishSlug(vanity)) {
    throw error(404, "errors.article.notFound", { code: 404 });
  }

  // Two independent knobs. `locale` is the reader's product-UI language, which
  // `hooks.server.ts` derives from their cookie and which reading a translated
  // article must never change. `articleLanguage` is which variant of THIS
  // article to fetch: the shared `?lang=` deep link when there is one, and
  // otherwise the reader's own locale as a sensible default. ( P9)
  const locale = locals.locale;
  // `normalizeContentLanguage`, NOT `normalizeLocale`. This parameter names the
  // language of the CONTENT, which can be any of the ~40 languages we sell a
  // translation into — the UI-locale normalizer lowercases the tag, throws away
  // everything after the primary subtag and then tests it against four locales,
  // so `zh-Hans` became `null` and a published Chinese translation was served
  // as English to every reader who asked for it by name.
  const requestedArticleLanguage = explicitArticleLanguage(
    url.searchParams.get("lang"),
  );
  const articleLanguage = resolveArticleLanguage({
    requestedLanguage: requestedArticleLanguage,
    uiLocale: locale,
  });
  setHeaders({ "cache-control": "private, no-cache", vary: "Cookie" });

  let article: ZPageDetail;
  let gated: boolean;
  // The variant actually rendered. Equal to `articleLanguage` except when the
  // range resolution below lands on a more specific tag.
  let servedLanguage = articleLanguage;
  // The selector the LAST fetch actually used. It stops being
  // `articleLanguage` the moment an unusable `?lang=` is recovered from, and
  // resolving a range against the rejected tag then finds nothing where the
  // crawler tier — which defaults to the same locale and resolves it — finds a
  // regional variant (codex adversarial review).
  let effectiveLanguage = articleLanguage;

  try {
    cookie = request.headers.get("cookie");
    const fetchVariant = async (
      language: string | undefined,
      signal?: AbortSignal,
    ) => {
      const response = await fetchJson<ZPageDetail | GatedArticleResponse>(
        `/api/zpage/${encodeURIComponent(vanity)}/`,
        cookie,
        fetch,
        { lang: language },
        signal,
      );
      return "page" in response
        ? { gated: true, article: response.page }
        : { gated: false, article: response };
    };

    try {
      ({ article, gated } = await fetchVariant(articleLanguage));
    } catch (variantError) {
      // A `?lang=` is a REPRESENTATION SELECTOR: it may pick which variant is
      // rendered, and it may never fail the page. `normalizeContentLanguage`
      // accepts any structurally valid BCP-47 tag, while the API validates
      // against the IANA registry, so `?lang=zz-ZZ` — or a tag from a future
      // registry, or one the API stops accepting — is a 400 there. Rendering
      // the canonical view instead is the documented contract; turning a
      // stranger's typo in a shared link into a 500 is not
      // (codex adversarial review).
      if (
        !(variantError instanceof ApiFetchError) ||
        variantError.status !== 400
      ) {
        throw variantError;
      }
      // A visitor's bad input, recovered from: a WARNING, not an ERROR.
      // (`console.warn` is stderr, which Cloud Logging grades ERROR;.)
      logSsrWarning(
        "article_lang_selector_unusable",
        "Unusable ?lang= selector; rendering the default variant",
        { articleLanguage, path: url.pathname },
      );
      // `DEFAULT_LOCALE`, not "no lang at all": the crawler tier degrades an
      // unusable tag to exactly this, and a query-free fetch would instead let
      // the API negotiate — which on a Spanish-source article with an English
      // translation serves Spanish here and English there, from one URL, each
      // declaring the other's canonical (codex adversarial review).
      ({ article, gated } = await fetchVariant(DEFAULT_LOCALE));
      servedLanguage = DEFAULT_LOCALE;
      effectiveLanguage = DEFAULT_LOCALE;
    }

    // The API matches `lang` EXACTLY, and `available_languages` — the only
    // place the variant list exists — arrives with the response. So a language
    // RANGE (`?lang=zh` on an article whose one Chinese variant is `zh-Hans`)
    // can only be resolved after this first answer, and asking again is the
    // only way to render it. At most one extra request, only when the first
    // answer was not the language that was asked for, and never when the
    // article carries two variants of the same language: guessing
    // between `zh-Hans` and `zh-Hant` is worse than the disclosure plus the
    // switcher.
    const retryLanguage = variantLanguageRetry({
      askedLanguage: effectiveLanguage,
      actualLanguage: (article as { actual_language?: string }).actual_language,
      availableLanguages: (
        article as { available_languages?: readonly string[] }
      ).available_languages,
    });
    if (retryLanguage) {
      // Bounded, and bounded HERE rather than by the platform's own request
      // deadline: everything after this point is optional.
      const retryAbort = createAbortSignalWithTimeout(
        request.signal,
        ARTICLE_VARIANT_RETRY_TIMEOUT_MS,
      );
      try {
        ({ article, gated } = await fetchVariant(
          retryLanguage,
          retryAbort.signal,
        ));
        servedLanguage = retryLanguage;
      } catch (retryError) {
        // The first answer is a perfectly renderable article. A failed — or
        // timed-out — second opinion must never turn a 200 into an error page,
        // and must never hold the response open either.
        logSsrError("article_variant_retry_failed", retryError, {
          retryLanguage,
          path: url.pathname,
        });
      } finally {
        retryAbort.cleanup();
      }
    }
  } catch (err) {
    // The API's 404 is this page's 404 — overwhelmingly a scanner asking for
    // `/<anything>/.env` — and is logged by nobody. It was Error
    // Reporting's #1 group at ~1,200 a day, above every real failure.
    if (err instanceof ApiFetchError && err.status === 404) {
      // Classic `/creator/<username>` profile links. Vanity FIRST, as
      // Django's `legacy_creator_social` did: an article whose vanity is
      // `<x>` still answers `/creator/<x>` (the lookup above), and only when
      // no article owns it does the old profile shape fall back to the
      // profile. `creator` is a reserved username, so no real creator's
      // `/creator/<vanity>` 404 is rewritten. Until  only Django's card
      // tier answered these links for unfurlers; now SvelteKit must.
      if (username.toLowerCase() === "creator") {
        throw redirect(301, `/${encodeURIComponent(vanity)}${url.search}`);
      }
      throw error(404, "errors.article.notFound", { code: 404 });
    }
    // A throttle, a refusal or a gone is the API's answer, not our 500
    //. See `$lib/server/upstream-status`.
    const upstream =
      err instanceof ApiFetchError
        ? upstreamClientError(err.status, err.retryAfter)
        : null;
    if (upstream) {
      // One WARNING, not an ERROR: see the profile route's note.
      logSsrWarning(
        "article_load_upstream_4xx",
        `zPage API answered ${(err as { status: number }).status}`,
        {
          path: url.pathname,
          upstream_status: (err as { status: number }).status,
          retry_after: upstream.retryAfter,
        },
      );
      if (upstream.retryAfter) {
        setHeaders({ "retry-after": upstream.retryAfter });
      }
      throw error(
        upstream.status,
        upstreamErrorMessage(upstream, "Failed to load article"),
        { code: upstream.status },
      );
    }
    logSsrError("article_load_failed", err, { path: url.pathname });
    throw error(500, "Failed to load article", { code: 500 });
  }

  // Canonicalize the username segment . The vanity is globally
  // unique, so /{any-username}/{vanity} resolves the same article; 301-redirect
  // to the owner's canonical URL so there is one indexable URL per article.
  // NOTE: this runs OUTSIDE the try/catch above on purpose — redirect() throws,
  // and the catch would otherwise swallow it into a 404. The compare is
  // case-insensitive so a correct-but-differently-cased username does not loop.
  // Only this new pretty [vanity] route is affected: the legacy
  // /{username}/zpage/{slug} route and the classic React UI are untouched.
  const canonicalUsername = article?.creator?.username;
  const canonicalPath = zpageCanonicalPath(article);
  if (
    canonicalUsername &&
    canonicalUsername.toLowerCase() !== username.toLowerCase() &&
    canonicalPath
  ) {
    throw redirect(301, `${canonicalPath}${url.search}`);
  }

  // `<html lang>` is rendered from this (`hooks.server.ts`). The variant that
  // was actually served, canonicalized — never the reader's UI locale, and
  // never the raw `?lang=`.
  locals.contentLanguage = normalizeContentLanguage(
    (article as { actual_language?: string }).actual_language,
  );

  // Streamed: the article renders immediately; these fill in when resolved.
  //
  // These are links to OTHER articles, and they are localized with the UI
  // locale, not `articleLanguage`, on purpose: both link to query-free URLs,
  // which resolve by the reader's locale. Titling them in the language of
  // the article currently being read would show a Spanish "Next part" that
  // opens in English. `?lang=` stays scoped to the one article it names.
  //
  // Started BEFORE the first-party cards are awaited below, so the two
  // deadlines overlap instead of adding (article-ssr-deadlines.js).
  const { relatedArticles, seriesContext } = loadArticleEnrichments(
    article,
    fetch,
    locale,
    request.signal,
    buildApiUrl,
    logSsrError,
    zpageCanonicalPath,
  );

  // `::embed[]` of another zPage / converse thread ( part 2): resolved
  // with THIS reader's cookie, so the card shows exactly what they could
  // open themselves; awaited so it is in the server-rendered body. Nothing is
  // resolved for a gated article (its body is the redacted upsell).
  const firstPartyCardSeed = await loadFirstPartyCardSeed({
    contents: [article.content],
    gated,
    fetch,
    cookie,
    locale,
    signal: request.signal,
    requestHostname: url.hostname,
  });
  // The body renders from these; the page resolver is seeded with the
  // whole seed, so comments reuse the calls instead of repeating them.
  const firstPartyCards = firstPartyCardSeed.cards;

  return {
    article,
    gated,
    relatedArticles,
    seriesContext,
    firstPartyCards,
    firstPartyCardSeed,
    locale,
    articleLanguage: servedLanguage,
    // Null unless the reader asked for a language explicitly. The disclosure
    // in `+page.svelte` uses this to stay quiet when nothing was asked for.
    requestedArticleLanguage,
    username,
    vanity,
  };
};
