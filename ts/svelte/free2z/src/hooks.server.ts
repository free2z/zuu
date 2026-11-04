import type { Handle, HandleServerError } from "@sveltejs/kit/hooks";
import * as publicEnv from "$app/env/public";
import { LOCALE_STORAGE_KEY, resolveRequestLocale } from "$lib/locale.js";
import { withRequestLocale } from "$lib/server/request-locale.js";
import { logSsrError } from "$lib/server/ssr-log";

export const handle: Handle = async ({ event, resolve }) => {
  // `?lang=` is a UI-locale override everywhere except the article routes,
  // where it selects which language variant of the *content* to render and
  // must leave the product UI alone. See `resolveRequestLocale` ( P9).
  const { locale, persisted } = resolveRequestLocale({
    routeId: event.route.id,
    queryLocale: event.url.searchParams.get("lang"),
    cookieLocale: event.cookies.get(LOCALE_STORAGE_KEY),
  });
  const selected = locale as App.Locals["locale"];
  event.locals.locale = selected;
  event.locals.localePersisted = persisted;

  // Bind the locale to this request's async context. `$lib/i18n` reads it from
  // there instead of its module-global store, so two concurrent renders cannot
  // observe each other's language even if the render path grows an `await`.
  // See issue.
  const response = await withRequestLocale(selected, () =>
    resolve(event, {
      // `<html lang>` declares the language of the DOCUMENT's own text, which
      // on an article page is the article. A zPage served as a published
      // `zh-Hans` translation under `<html lang="en">` is wrong before a
      // reader gets to the body: it is what a crawler reads first, and it is
      // what a browser picks Han glyph variants and a screen reader picks its
      // voice from — and Simplified and Traditional are different glyphs for
      // the same code points, so "close enough" does not exist here.
      //
      // Read INSIDE the callback, not closed over above: `locals` is set by
      // the page's `load`, which runs after `resolve()` is entered and before
      // the first chunk is produced. Every other route leaves it unset and
      // keeps the product-UI locale, which is all it ever had.
      //
      // The value is always a canonical tag from `normalizeContentLanguage`
      // (letters, digits and hyphens), so it cannot break out of the
      // attribute — raw query input must never reach this line.
      transformPageChunk: ({ html }) =>
        html.replace(
          '<html lang="en">',
          `<html lang="${event.locals.contentLanguage || selected}">`,
        ),
    }),
  );

  const contentType = response.headers.get("content-type") || "";
  const isHtml = contentType.includes("text/html");
  const isPageData = event.url.pathname.endsWith("/__data.json");
  const isVersionMetadata = event.url.pathname === "/_app/version.json";

  // The rendered HTML depends on the locale cookie, and ?lang is already part
  // of the cache key by virtue of being in the URL. Page-data responses can
  // contain the same cookie-backed data even though they are JSON. Keep both
  // response classes private so a host/path/query-only CDN cache can never
  // leak one visitor's render to the next.
  if (isHtml && !response.headers.has("cache-control")) {
    response.headers.set("cache-control", "private, no-cache");
  }
  if (isPageData) {
    response.headers.set("cache-control", "private, no-cache");
  }
  if (isVersionMetadata) {
    response.headers.set("cache-control", "no-store");
  }

  if (isHtml || isPageData) {
    const existing = response.headers.get("vary");
    if (!existing) {
      response.headers.set("vary", "Cookie");
    } else if (!/(^|,)\s*cookie\s*($|,)/i.test(existing)) {
      response.headers.set("vary", existing + ", Cookie");
    }
  }

  // Make mixed-revision responses visible in origin logs and deployment
  // smoke checks without exposing any request data.
  if (publicEnv.PUBLIC_BUILD_SHA) {
    response.headers.set("x-f2z-ui-version", publicEnv.PUBLIC_BUILD_SHA);
  }

  return response;
};

/**
 * SvelteKit calls this for every error that is not an `error()` a loader
 * threw on purpose — including an UNMATCHED ROUTE (`SvelteKitError` 404) and
 * a POST to a page with no actions (405). The framework default
 * `console.error`s all of them in ANSI red on stderr, which Cloud Logging
 * grades ERROR: that is every scanner probe of `/wp-admin` or
 * `/storage/logs/laravel.log`.
 *
 * Below 500 the request log already has the status and there is nothing to
 * fix, so nothing is logged. 500 and up is a real exception: one JSON line,
 * stack included, which Error Reporting still groups. Returning nothing keeps
 * SvelteKit's own `{ message }` for the error page.
 */
export const handleError: HandleServerError = ({ error, event, kind }) => {
  const status = kind === "unknown" ? 500 : error.status;
  if (status < 500) return;
  logSsrError("ssr_unhandled_error", error, {
    status,
    method: event.request.method,
    path: event.url.pathname,
    route: event.route.id,
  });
};
