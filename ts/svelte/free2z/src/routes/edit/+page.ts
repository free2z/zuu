import type { PageLoad } from "./$types";
import { error, redirect } from "@sveltejs/kit";
import { t } from "$lib/i18n";
import { normalizeContentLanguage } from "$lib/zpage-language.js";
import type { ZPage } from "$lib/types/zpage";
import { loginDestination } from "$lib/login-destination";

export const ssr = false;

// `returnTo` is this route's own `pathname + search` (`/edit?id=42&lang=fr`),
// so the creator lands back in the editor they asked for after signing in
//. It passes through the same `next` guard as every other return path.
async function fetchCurrentUser(fetchFn: typeof fetch, returnTo: string) {
  const response = await fetchFn("/api/auth/user/", {
    credentials: "include",
  });

  if (response.status === 401 || response.status === 403) {
    throw redirect(302, loginDestination(returnTo));
  }

  if (!response.ok) {
    throw error(
      502,
      t(
        "editor.editorUserLoadFailed",
        "Failed to load your account for the editor.",
      ),
      { code: response.status },
    );
  }

  return response.json();
}

async function fetchOwnedZPage(
  fetchFn: typeof fetch,
  identifier: string,
  language: string | null | undefined,
  returnTo: string,
) {
  const params = new URLSearchParams({ mine: "true" });
  if (language) params.set("lang", language);
  const response = await fetchFn(
    `/api/zpage/${encodeURIComponent(identifier)}/?${params.toString()}`,
    {
      credentials: "include",
    },
  );

  if (response.status === 401 || response.status === 403) {
    throw redirect(302, loginDestination(returnTo));
  }

  if (response.status === 404) {
    throw error(404, t("editor.articleNotFound", "Article not found."), {
      code: 404,
    });
  }

  if (!response.ok) {
    throw error(
      502,
      t("editor.articleLoadFailed", "Failed to load the article."),
      { code: response.status },
    );
  }

  // The optimistic-concurrency validator for the CANONICAL article.
  // It describes the canonical row even when `?lang=` rendered a translation,
  // because the write on this URL always writes the canonical article  —
  // so it is only ever sent back on a canonical save. A translation's own
  // validator comes from that variant's own read, and in the editor it arrives
  // on the first translation save's response.
  //
  // `null` when the header is absent (an older backend, a proxy that strips
  // it): the save then goes out unconditioned, which is exactly the behaviour
  // that shipped before this feature. A missing validator must never block a
  // save.
  const etag = response.headers?.get?.("ETag") || null;

  return { zpage: (await response.json()) as ZPage, etag };
}

/**
 * The translation variant itself — body AND validator, from ONE response.
 *
 * `GET /api/zpage/{id}/?lang=fr` renders the French text but its `ETag`
 * describes the CANONICAL article, because that is the only thing a write to
 * that URL can change. Fetching the validator separately was the
 * obvious workaround and is a worse bug than the one it fixes: between the two
 * requests another tab can save, and this tab then holds stale text paired
 * with a fresh validator — a PUT that passes its precondition and overwrites
 * the newer version, which is the exact lost update  exists to prevent,
 * now wearing a badge that says it is protected. It also runs the detail
 * endpoint (64 published + 64 draft translations, 100,000 characters each at
 * the documented ceilings) twice to read one header. (codex adversarial
 * review.)
 *
 * `/variants/{language}/` returns the same body — `zPageDetailSerializer` with
 * `translation_language` in context, the same call `?lang=` makes — with that
 * variant's own `ETag`. One request, one consistent snapshot.
 *
 * `null` on anything other than a 200, which includes the 404 for a language
 * with no variant yet. The caller falls back to the article read, exactly as
 * before this feature existed; a missing validator must never block the editor
 * from opening.
 */
async function fetchOwnedVariant(
  fetchFn: typeof fetch,
  identifier: string,
  language: string,
): Promise<{ zpage: ZPage; etag: string | null } | null> {
  try {
    const response = await fetchFn(
      `/api/zpage/${encodeURIComponent(identifier)}/variants/${encodeURIComponent(language)}/?mine=true`,
      { credentials: "include" },
    );
    if (!response.ok) return null;
    const zpage = (await response.json()) as ZPage;
    // A 200 is not proof this is the variant we asked for. An older pod
    // without the route, a proxy, a service worker or a stale cache can all
    // answer 200 with something else entirely, and whatever comes back here
    // is hydrated straight into the composer -- so a body that is not this
    // article's variant empties the editor rather than failing loudly. Check
    // the identity and the language the response claims, and fall back to the
    // article read when either disagrees.
    // The identifier may be either form the route accepts — the `free2zaddr`
    // UUID or the vanity slug — and the editor rewrites its own URL to the
    // vanity after a save, so the vanity is the COMMON case here. Comparing
    // only against `free2zaddr` rejected every correct response for a
    // vanity-addressed article and quietly fell back to the unprotected path.
    // (codex adversarial review.)
    const addressesThisPage =
      zpage?.free2zaddr === identifier || zpage?.vanity === identifier;
    if (
      !addressesThisPage ||
      (zpage.actual_language && zpage.actual_language !== language)
    ) {
      return null;
    }
    return { zpage, etag: response.headers?.get?.("ETag") || null };
  } catch {
    return null;
  }
}

export const load: PageLoad = async ({ fetch, url, parent }) => {
  try {
    const layout = await parent();
    // A zPage's language is CONTENT language, not one of the four product-UI
    // locales. Filtering `?lang=` through the UI-locale normalizer is why a
    // `ja` variant created through the API is unreachable in the editor today
    //the tag was dropped, the source variant loaded instead, and the
    // editor believed it was looking at Japanese.
    const explicitLanguage = normalizeContentLanguage(
      url.searchParams.get("lang"),
    );
    const returnTo = url.pathname + url.search;
    const currentUser = await fetchCurrentUser(fetch, returnTo);
    const requestedId = url.searchParams.get("id")?.trim() || "new";

    if (requestedId === "new") {
      return {
        currentUser,
        requestedId,
        zpage: null,
        zpageEtag: null,
        variantLanguage: null,
        variantEtag: null,
        explicitLanguage,
        requestedLanguage: explicitLanguage || layout.locale || "en",
      };
    }

    // One request wherever possible, and never a body from one request paired
    // with a validator from another.
    const exact = explicitLanguage
      ? await fetchOwnedVariant(fetch, requestedId, explicitLanguage)
      : null;
    const { zpage, etag } =
      exact ??
      (await fetchOwnedZPage(fetch, requestedId, explicitLanguage, returnTo));
    const requestedLanguage =
      explicitLanguage ||
      zpage.actual_language ||
      zpage.source_language ||
      layout.locale ||
      "en";

    // Which resource that validator describes. A variant read of the article's
    // OWN language is a canonical read — the API returns the canonical
    // validator for it, because writing that language writes the article.
    const isVariantValidator = Boolean(
      exact && explicitLanguage && explicitLanguage !== zpage.source_language,
    );
    const zpageEtag = isVariantValidator ? null : etag;
    const variantLanguage = isVariantValidator ? explicitLanguage : null;
    const variantEtag = isVariantValidator ? etag : null;

    if (zpage.creator.username !== currentUser.username) {
      throw redirect(
        302,
        `/${encodeURIComponent(currentUser.username)}/dashboard/pages`,
      );
    }

    return {
      currentUser,
      requestedId,
      zpage,
      zpageEtag,
      variantLanguage,
      variantEtag,
      // Whether the creator ASKED for a specific variant, as opposed to
      // landing on whatever the article resolves to. Once detection ships,
      // `source_language` is null while it is pending, and this is the only
      // thing that still distinguishes "the canonical article" from "the
      // translation I navigated to" — which is what decides whether a save is
      // a canonical write or a translation write.
      explicitLanguage,
      requestedLanguage,
    };
  } catch (err: any) {
    if (err?.status) {
      throw err;
    }

    throw error(
      502,
      t(
        "editor.backendUnavailable",
        "The editor cannot reach the server right now.",
      ),
      { code: 502 },
    );
  }
};
