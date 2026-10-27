import type { PageServerLoad } from "./$types";
import { error, redirect } from "@sveltejs/kit";
import { loginDestination } from "$lib/login-destination";
import {
  getApiBase,
  getSessionCookie,
  requireAuthenticatedUser,
} from "$lib/server/backend";

/**
 * Server load for the revenue-share identity-verification (KYC) flow.
 *
 * Two things this deliberately does NOT do:
 *
 * 1. **It never returns a document URL.** The identity documents live behind
 *    `/uploadz/private/...`, which nginx gates on an authenticated session, but
 *    a URL that reaches this load's return value is serialized into the SSR
 *    HTML payload. Previews are therefore fetched by the browser after mount;
 *    the server hands back presence booleans only, which is all the stepper
 *    needs to work out where to resume. No identity document is ever part of a
 *    server-rendered page.
 *
 * 2. **It never caches.** `private, no-store` plus an explicit
 *    `X-Robots-Tag`. The `+layout.svelte` `privateSurface` regex already emits
 *    a `noindex` meta tag for any `/dashboard/` path, but a meta tag only helps
 *    a crawler that renders HTML — the header covers everything else, and the
 *    two are cheap enough to have both.
 */
export const load: PageServerLoad = async ({
  params,
  cookies,
  fetch,
  url,
  setHeaders,
}) => {
  const sessionId = getSessionCookie(cookies);
  if (!sessionId) {
    throw redirect(302, loginDestination(url.pathname));
  }

  setHeaders({
    "cache-control": "private, no-store",
    vary: "Cookie",
    "x-robots-tag": "noindex, nofollow, noarchive, noimageindex",
  });

  const creator = await requireAuthenticatedUser(fetch, cookies, url.pathname);

  if (creator.username !== params.username) {
    throw error(403, "errors.dashboard.kycForbidden", { code: 403 });
  }

  const apiBase = getApiBase();

  // Each read is independent and independently fallible. A 500 on the
  // identity-documents endpoint must degrade to "nothing uploaded yet" so the
  // applicant can still work on the other steps, rather than blanking the whole
  // page — this flow is the only KYC intake migrated creators have.
  const read = async (path: string) => {
    try {
      const response = await fetch(`${apiBase}${path}`, {
        headers: { Cookie: `sessionid=${sessionId}` },
      });
      if (!response.ok) {
        console.error("KYC read failed", { path, status: response.status });
        return null;
      }
      return await response.json();
    } catch (err) {
      console.error("KYC read errored", {
        path,
        name: err instanceof Error ? err.name : "unknown",
      });
      return null;
    }
  };

  const [profile, taxForm, documents, signature] = await Promise.all([
    read("/api/kyc/user-profile"),
    read("/api/kyc/get-tax-form-file"),
    read("/api/kyc/identity-documents"),
    read("/api/kyc/tax-form-signature"),
  ]);

  if (!profile) {
    throw error(503, "errors.dashboard.kycLoadFailed", { code: 503 });
  }

  return {
    username: params.username,
    // Preserve exact decimal text for live account observation. The eligibility
    // note is informational; the human reviewer remains the application gate.
    tuzis: String(creator.tuzis ?? "0"),
    balance_snapshot: (creator as { balance_snapshot?: string })
      .balance_snapshot,
    profile: {
      application_status: profile.application_status ?? "NEW",
      is_us: profile.is_us ?? null,
      is_individual: profile.is_individual ?? null,
      rejection_reason: profile.rejection_reason ?? "",
      tax_form_signature: signature?.tax_form_signature ?? "",
    },
    hasTaxForm: Boolean(taxForm?.file),
    // Presence, never the URL. See the note above.
    documents: {
      id_front: Boolean(documents?.id_front_url),
      id_back: Boolean(documents?.id_back_url),
      additional_document: Boolean(documents?.additional_document_url),
      live_photo: Boolean(documents?.live_photo_url),
    },
  };
};
