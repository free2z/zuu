import { zpageRetrieve } from "$lib/api/zpage/zpage";
import { createAbortSignalWithTimeout } from "$lib/abort-signal.js";
import { ARTICLE_VARIANT_RETRY_TIMEOUT_MS } from "$lib/article-ssr-deadlines.js";
import { DEFAULT_LOCALE } from "$lib/locale.js";
import type { ZPageDetail } from "$lib/api/f2z.schemas";
import {
  explicitArticleLanguage,
  normalizeContentLanguage,
  resolveArticleLanguage,
  variantLanguageRetry,
} from "$lib/zpage-language.js";
import { error } from "@sveltejs/kit";
import { loadFirstPartyCardSeed } from "$lib/server/first-party-embed-cards";
import { logSsrError, logSsrWarning } from "$lib/server/ssr-log";
import { ApiError } from "$lib/api/mutator";
import {
  upstreamClientError,
  upstreamErrorMessage,
} from "$lib/server/upstream-status";
import type { PageServerLoad } from "./$types";

type GatedArticleResponse = { show_modal: boolean; page: ZPageDetail };

// The language-range retry is optional work on top of an article we already
// hold. Bounded so a stalled second fetch cannot turn a rendered page into a
// gateway timeout (codex adversarial review) -- and bounded by the SAME number
// the zPage route uses, from $lib/article-ssr-deadlines.js, which is also what
// the browser deadline spec derives its bound from.

function isStatus(error: unknown, status: number) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "status" in error &&
    (error as { status?: unknown }).status === status,
  );
}

export const load: PageServerLoad = async ({
  params,
  request,
  setHeaders,
  url,
  locals,
  fetch,
}) => {
  try {
    // The segment is a `free2zaddr` (a UUID) or a `vanity` slug — never a
    // database primary key. `zpageRetrieve` used to be typed `number` because
    // drf-spectacular inferred the model pk ( §2), and this route
    // `parseInt`ed to satisfy that type: every UUID became `NaN` and 404'd
    // here without the API ever being asked. The only links to this route are
    // `/article/${page.free2zaddr}`, so the guard was rejecting exactly the
    // identifiers it is given. Now the type says what the route accepts and
    // the segment is passed through as written.
    //
    // `encodeURIComponent` because SvelteKit hands route params back DECODED,
    // and `zpageRetrieve` interpolates them straight into the path. Without it
    // an id of `..%2Fstripe%2Ftransactions` arrives here as
    // `../stripe/transactions` and `fetch` normalizes the result into a
    // different authenticated backend route — with the visitor's cookie
    // forwarded. `[username]/[vanity]/+page.server.ts` already encodes every
    // identifier it interpolates; this route was the one that did not, and the
    // `parseInt` was incidentally hiding it. (codex adversarial review.)
    const id = params.id ? encodeURIComponent(params.id) : "";
    if (!id) {
      throw error(404, "errors.article.notFound", { code: 404 });
    }

    const cookie = request?.headers?.get("cookie");
    // A CONTENT language, so `normalizeContentLanguage` — the UI-locale
    // normalizer drops the script subtag and then rejects anything outside the
    // four locales the product UI ships in, which is how `?lang=zh-Hans`
    // silently rendered English here too.
    const requestedArticleLanguage = explicitArticleLanguage(
      url.searchParams.get("lang"),
    );
    const articleLanguage = resolveArticleLanguage({
      requestedLanguage: requestedArticleLanguage,
      uiLocale: locals.locale,
    });

    // The forwarded cookie only started reaching the API in. An owner can
    // now retrieve their own unpublished page here, so this render is
    // per-visitor and must not be shared by a URL-keyed cache. Mirrors what
    // /[username]/[vanity] already declares.
    setHeaders({ "cache-control": "private, no-cache", vary: "Cookie" });

    const retrieveVariant = async (
      language: string | undefined,
      signal?: AbortSignal,
    ) => {
      const response = (await zpageRetrieve(
        id,
        language ? { lang: language } : undefined,
        {
          headers: cookie ? { cookie } : undefined,
        },
        signal,
      )) as ZPageDetail | GatedArticleResponse;
      const isGated = "page" in response;
      return {
        gated: isGated,
        article: isGated ? response.page : (response as ZPageDetail),
      };
    };

    let article: ZPageDetail;
    let gated: boolean;
    // The selector the last fetch actually used; see the sibling note in
    // `/[username]/[vanity]`.
    let effectiveLanguage = articleLanguage;
    try {
      ({ article, gated } = await retrieveVariant(articleLanguage));
    } catch (variantError) {
      // `?lang=` selects a representation and may never fail the page: the API
      // validates the tag against the IANA registry and 400s one that is
      // merely well-formed (`zz-ZZ`). Render the canonical view instead
      // (codex adversarial review).
      if (!isStatus(variantError, 400)) throw variantError;
      // A WARNING, not stderr's ERROR.
      logSsrWarning(
        "article_lang_selector_unusable",
        "Unusable ?lang= selector; rendering the default variant",
        { articleLanguage, path: url.pathname },
      );
      // The same explicit default the crawler tier uses, so one URL cannot
      // serve two languages across tiers (codex adversarial review).
      ({ article, gated } = await retrieveVariant(DEFAULT_LOCALE));
      effectiveLanguage = DEFAULT_LOCALE;
    }

    // Same one-extra-request range resolution as `/[username]/[vanity]`: the
    // API matches `lang` exactly, and only the response knows which tags exist,
    // so `?lang=zh` on an article whose one Chinese variant is `zh-Hans` can
    // only be resolved after the first answer. Never fires when the article has
    // two variants of the same language — guessing is 's defect.
    const retryLanguage = variantLanguageRetry({
      askedLanguage: effectiveLanguage,
      actualLanguage: (article as { actual_language?: string }).actual_language,
      availableLanguages: (
        article as { available_languages?: readonly string[] }
      ).available_languages,
    });
    if (retryLanguage) {
      const retryAbort = createAbortSignalWithTimeout(
        request?.signal,
        ARTICLE_VARIANT_RETRY_TIMEOUT_MS,
      );
      try {
        ({ article, gated } = await retrieveVariant(
          retryLanguage,
          retryAbort.signal,
        ));
      } catch (retryError) {
        // The first answer renders fine; a failed second opinion must never
        // turn a 200 into an error page.
        logSsrError("article_variant_retry_failed", retryError, {
          retryLanguage,
          path: url.pathname,
        });
      } finally {
        retryAbort.cleanup();
      }
    }

    // `<html lang>` is rendered from this (`hooks.server.ts`).
    locals.contentLanguage = normalizeContentLanguage(
      (article as { actual_language?: string }).actual_language,
    );

    // First-party content cards ( part 2), as THIS reader; see the
    // zPage route. Never throws, so it cannot turn the page into a 503.
    const firstPartyCardSeed = await loadFirstPartyCardSeed({
      contents: [article.content],
      gated,
      fetch,
      cookie,
      locale: locals.locale,
      signal: request?.signal,
      requestHostname: url.hostname,
    });
    // The body renders from these; the page resolver is seeded with the
    // whole seed, so comments reuse the calls instead of repeating them.
    const firstPartyCards = firstPartyCardSeed.cards;

    return {
      article,
      gated,
      firstPartyCards,
      firstPartyCardSeed,
    };
  } catch (err) {
    // A 404 — the API's, or this route's own for an empty id — is the
    // answer, not a failure, and is logged by nobody.
    if (isStatus(err, 404)) {
      throw error(404, "errors.article.notFound", { code: 404 });
    }
    // A throttle, a refusal or a gone is the API's answer, not our 503
    //. See `$lib/server/upstream-status`.
    const upstream =
      err instanceof ApiError
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
    throw error(503, "Failed to load article", { code: 503 });
  }
};
