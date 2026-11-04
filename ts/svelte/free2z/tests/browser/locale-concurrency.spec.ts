import { expect, test } from "@playwright/test";

// Issue: the SSR locale used to live in a module-scoped store shared by
// every request in the Node process. This spec is the end-to-end guard on the
// property that matters — a page rendered for one language never contains
// another language's copy, no matter what else the server is rendering at the
// same time.
//
// Honest note on what this proves: it passed before the fix too, because
// Svelte's SSR render is synchronous and nothing currently awaits between
// `setLocale(data.locale)` and the first `$t` read. It exists so that the day
// someone introduces an await on the render path — a server-rendered `{#await}`
// using `$t`, an async component, Svelte's async SSR — the failure surfaces
// here instead of in production. The mechanism-level proof lives in
// `tests/i18n-request-locale.test.mjs`.

// Footer copy, rendered by the root layout on every page.
const MARKERS = {
  en: "Help center",
  es: "Centro de ayuda",
  fr: "Centre d’aide",
} as const;

type Locale = keyof typeof MARKERS;
const LOCALES = Object.keys(MARKERS) as Locale[];

const PATHS = ["/", "/trending", "/creators"];
const CONCURRENCY = 12;

test("concurrent SSR renders never leak another request's language", async ({
  request,
}) => {
  for (const path of PATHS) {
    const separator = path.includes("?") ? "&" : "?";

    const renders = await Promise.all(
      Array.from({ length: CONCURRENCY }, async (_, index) => {
        const locale = LOCALES[index % LOCALES.length];
        const response = await request.get(`${path}${separator}lang=${locale}`);
        expect(response.status()).toBe(200);
        return { locale, html: await response.text() };
      }),
    );

    for (const { locale, html } of renders) {
      const foreign = LOCALES.filter(
        (candidate) =>
          candidate !== locale && html.includes(MARKERS[candidate]),
      );

      expect(
        {
          path,
          locale,
          htmlLang: /<html lang="([^"]+)"/.exec(html)?.[1],
          foreign,
        },
        `${path}?lang=${locale} must render only ${locale} copy`,
      ).toEqual({ path, locale, htmlLang: locale, foreign: [] });

      expect(
        html,
        `${path}?lang=${locale} must render ${locale} copy`,
      ).toContain(MARKERS[locale]);
    }
  }
});

test("HTML responses tell caches they vary by the locale cookie", async ({
  request,
}) => {
  // `?lang` is part of the URL and therefore already a cache key; the cookie is
  // not. Without `Vary: Cookie` a shared cache can hand one visitor's language
  // to the next.
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/html");
  expect(response.headers()["vary"] ?? "").toMatch(/\bcookie\b/i);
});
