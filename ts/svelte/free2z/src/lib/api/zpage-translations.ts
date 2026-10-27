/**
 * Small compatibility layer around the generated zPage translation endpoints.
 *
 * Orval owns request paths and payload contracts. This file keeps deployment
 * feature detection, response normalization, and the `Idempotency-Key` header
 * that orval does not emit for documented header parameters.
 *
 * **Feature detection is the point of `listTranslationJobs`.** This frontend
 * may reach production before the backend that answers it. A pod without the
 * route answers 404 (or, behind the SPA catch-all in a test, something that is
 * not an array). Both mean "this deployment cannot list jobs", and the caller
 * falls back to the per-language status endpoint it has always used. The
 * answer is cached per SPA session by the caller, never here.
 */
import { ApiError } from "$lib/api/mutator";
import { apiFetch } from "$lib/api/config";
import { preconditionHeaders } from "$lib/zpage-preconditions.js";
import type {
  TranslationBatchQuote,
  TranslationBatchQuoteItem,
  TranslationBatchPurchase,
  ZpageTranslationBatchQuoteParams,
} from "$lib/api/f2z.schemas";
import {
  normalizeJobsListing,
  normalizeServerJob,
  type JobsListing,
  type ServerTranslationJob,
} from "$lib/translation-jobs";

export type { ServerTranslationJob } from "$lib/translation-jobs";

/** One line of a bulk quote. `available: false` carries a `reason` code. */
export type BulkQuoteItem = TranslationBatchQuoteItem;

/** `GET …/translations/quote/` ( `zpage_translation_batch_quote`). */
export type BulkQuote = TranslationBatchQuote & {
  /** Client-side: the article this quote prices. Never sent. */
  page?: string;
};

export type BulkPurchaseBody = TranslationBatchPurchase;

/** A 404/405/501 on a jobs route means "not deployed here", not "failed". */
function isMissingRoute(error: unknown) {
  return (
    error instanceof ApiError && [404, 405, 501].includes(Number(error.status))
  );
}

/**
 * The latest job per language for this zPage, or `null` when this deployment
 * has no jobs list. Throws on a real failure (5xx, network) so the caller can
 * tell "unsupported" from "could not ask".
 */
export async function listTranslationJobs(
  free2zaddr: string,
  signal?: AbortSignal,
): Promise<JobsListing | null> {
  try {
    // Keep the generated zPage module off the root-layout path: this helper is
    // imported by the app-wide jobs store, but only editor actions need these
    // endpoints.
    const { zpageTranslationJobs } = await import("$lib/api/zpage/zpage");
    const answer = await zpageTranslationJobs(
      encodeURIComponent(free2zaddr),
      { timeoutMs: 20_000 },
      signal,
    );
    // Anything that is not a listing (a catch-all answering for a route this
    // deployment lacks) is "unsupported", never an empty tray.
    return normalizeJobsListing(answer);
  } catch (error) {
    if (isMissingRoute(error)) return null;
    throw error;
  }
}

/**
 * Price several languages at once. `null` when the route is not deployed, or
 * when what came back is not a quote (a catch-all answering for it).
 */
export async function quoteTranslations(
  free2zaddr: string,
  languages: readonly string[],
  signal?: AbortSignal,
): Promise<BulkQuote | null> {
  try {
    // Bounded: a stalled read must not leave "Working out the price…" on
    // screen forever with the retry hidden (codex adversarial review).
    const { zpageTranslationBatchQuote } = await import("$lib/api/zpage/zpage");
    const quote = await zpageTranslationBatchQuote(
      encodeURIComponent(free2zaddr),
      { languages: languages.join(",") } as ZpageTranslationBatchQuoteParams,
      { timeoutMs: 20_000 },
      signal,
    );
    if (
      !quote ||
      typeof quote !== "object" ||
      !Array.isArray((quote as BulkQuote).items) ||
      typeof (quote as BulkQuote).source_digest !== "string"
    )
      return null;
    return quote as BulkQuote;
  } catch (error) {
    if (isMissingRoute(error)) return null;
    throw error;
  }
}

/**
 * Buy every item in ONE request, all or nothing, under ONE batch key.
 *
 * The caller mints `idempotencyKey` once per decision and re-sends it on any
 * ambiguous retry — that is the whole double-charge defence, exactly as for
 * the single-language purchase.
 */
export async function purchaseTranslations(
  free2zaddr: string,
  body: BulkPurchaseBody,
  idempotencyKey: string,
): Promise<{ jobs: ServerTranslationJob[] }> {
  const { zpageTranslationBatchPurchase } =
    await import("$lib/api/zpage/zpage");
  const answer = await zpageTranslationBatchPurchase(
    encodeURIComponent(free2zaddr),
    body,
    { headers: { "Idempotency-Key": idempotencyKey } },
  );
  return {
    jobs: (Array.isArray(answer?.jobs) ? answer.jobs : [])
      .map(normalizeServerJob)
      .filter((job): job is ServerTranslationJob => job !== null),
  };
}

/**
 * Publish one translation draft as it is on the server.
 *
 * Use the revision captured from the jobs listing before approval: a
 * tray "Publish" must never publish a version the creator has not seen if
 * somebody saved over it in between. Missing revisions fail closed; a 412
 * surfaces as an `ApiError` for the caller.
 */
export async function publishTranslationVariant(
  free2zaddr: string,
  language: string,
  revision?: string,
): Promise<void> {
  if (!revision)
    throw new ApiError(
      "Cannot publish without the revision that was reviewed",
      428,
      null,
    );
  // Lazily, like the store's status read: this module is reachable from the
  // root layout, and the generated client must not ride along with it.
  const { zpageVariantsPartialUpdate } = await import("$lib/api/zpage/zpage");
  await zpageVariantsPartialUpdate(
    free2zaddr,
    language,
    { is_published: true },
    { headers: preconditionHeaders(revision) },
  );
}
