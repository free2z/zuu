/**
 * The bulk "Translate…" purchase ( D), out of `routes/edit/+page.svelte`
 * ( review).
 *
 * The rules this module holds:
 *
 * - **No durable record, no request.** The purchase's intent — its quote,
 *   lines and `Idempotency-Key` — is written to storage BEFORE the POST, and
 *   removed only by an answer that settles it: a 202, or a refusal that
 *   proves nothing was charged. Closing the dialog, navigating or reloading
 *   must not turn a lost answer into a fresh key and a second charge.
 * - **One unresolved purchase per article.** Another tab's intent is the only
 *   record of ITS key; overwriting it would let a later click charge that
 *   decision twice.
 * - **The article is the QUOTE's**, never "the one on screen now": a replay
 *   after navigating away still goes to the same article.
 */
import { toast, captureAccountToast } from "$lib/toast.js";
import { ApiError } from "$lib/api/mutator";
import {
  purchaseTranslations,
  type BulkQuote,
} from "$lib/api/zpage-translations";
import { translationJobs } from "$lib/stores/translationJobs";
import type { ServerTranslationJob } from "$lib/translation-jobs";
import {
  SETTLEMENT_POLICY_VERSION,
  isNoChargeRefusal,
} from "$lib/zpage-translation-purchase.js";

type Translate = (
  key: string,
  fallback: string,
  vars?: Record<string, string | number>,
) => string;

export interface BulkIntent {
  key: string;
  languages: string[];
  quote: BulkQuote;
}

type IntentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Where an article's unresolved bulk purchase lives. */
export function bulkIntentStorageKey(receiptKey: string) {
  return `${receiptKey}:bulk`;
}

export function readBulkIntentFrom(
  storage: IntentStorage | null,
  storageKey: string,
): BulkIntent | null {
  if (!storage) return null;
  try {
    const stored = JSON.parse(storage.getItem(storageKey) ?? "null");
    return stored &&
      typeof stored.key === "string" &&
      Array.isArray(stored.languages) &&
      stored.quote &&
      Array.isArray(stored.quote.items)
      ? (stored as BulkIntent)
      : null;
  } catch {
    return null;
  }
}

/** Remove the intent, but only if it is still THIS decision's. */
export function clearBulkIntentIn(
  storage: IntentStorage | null,
  storageKey: string,
  key: string,
) {
  try {
    if (readBulkIntentFrom(storage, storageKey)?.key === key)
      storage?.removeItem(storageKey);
  } catch {
    /* Kept: re-sending the same key is always safe. */
  }
}

export interface BulkPurchaseContext {
  storage: () => IntentStorage | null;
  /** The article's receipt key (`translation-receipt:{user}:{page}`). */
  receiptKey: (page: string) => string;
  /** The single-language purchase's cross-tab lock, shared on purpose. */
  withLock: (page: string, fn: () => void) => Promise<unknown>;
  /** The original authenticated session still owns this purchase. */
  isOwned?: () => boolean;
  /** The editor still has this article open. */
  isHere: (page: string) => boolean;
  /** The stored intent changed: re-read it into the editor's state. */
  onIntentChanged: (page: string) => void;
  t: () => Translate;
  list: (languages: readonly string[]) => string;
}

/**
 * Buy exactly `languages` of `quote` under `key`, all or nothing.
 * Throws an `ApiError` the dialog explains; resolves once the jobs exist.
 */
export async function purchaseBulkTranslations(
  ctx: BulkPurchaseContext,
  quote: BulkQuote,
  languages: string[],
  key: string,
  fallbackPage: string | null,
) {
  const operationNotice = captureAccountToast();
  const identifier = quote.page ?? fallbackPage;
  if (!identifier) throw new ApiError("No article", 400, null);
  const storage = ctx.storage();
  const storageKey = bulkIntentStorageKey(ctx.receiptKey(identifier));
  const t = ctx.t();
  const selected = quote.items.filter((item) =>
    languages.includes(item.language),
  );
  if (
    selected.length !== languages.length ||
    selected.some((item) => item.price === null)
  ) {
    throw new ApiError(
      t(
        "editor.translateAiQuoteUnavailable",
        "One or more selected translations are no longer available at this quote. Get a new quote before buying.",
      ),
      409,
      null,
    );
  }
  const items = selected.map((item) => ({
    language: item.language,
    expected_price: item.price as number,
  }));
  let conflict = false;
  try {
    await ctx.withLock(identifier, () => {
      if (!operationNotice.isCurrent() || ctx.isOwned?.() === false)
        throw new Error("Account changed before purchase");
      const existing = readBulkIntentFrom(storage, storageKey);
      if (existing && existing.key !== key) {
        conflict = true;
        return;
      }
      if (!storage) throw new Error("no storage");
      storage.setItem(storageKey, JSON.stringify({ key, languages, quote }));
    });
  } catch {
    // Same rule as the single-language purchase: no durable record, no
    // request. Nothing was sent, so nothing is undecided.
    const message = t(
      "editor.translateAiErrorStorage",
      "Browser storage is unavailable. Restore it and check any previous payment before retrying. This attempt was not sent.",
    );
    throw new ApiError(message, 400, { error: message });
  }
  if (conflict) {
    if (ctx.isHere(identifier)) ctx.onIntentChanged(identifier);
    const message = t(
      "translationJobs.otherPurchaseUnresolved",
      "Another purchase for this article has not been confirmed yet. Close this and open Translate… again to re-send it — this attempt was not sent.",
    );
    throw new ApiError(message, 409, { error: message });
  }
  if (!operationNotice.isCurrent() || ctx.isOwned?.() === false) return;
  // Hold saves BEFORE the request leaves: the debit can commit while the
  // answer is still on its way, and a visibility flush in that window would
  // change the very text the jobs translate (codex adversarial review). The
  // intent's languages count as running until it is resolved.
  if (ctx.isHere(identifier)) ctx.onIntentChanged(identifier);
  let jobs: ServerTranslationJob[];
  try {
    ({ jobs } = await purchaseTranslations(
      identifier,
      {
        items,
        source_digest: quote.source_digest,
        // The dialog states the same terms as the single-language one.
        settlement_policy: SETTLEMENT_POLICY_VERSION,
      },
      key,
    ));
  } catch (error) {
    if (isNoChargeRefusal(error)) clearBulkIntentIn(storage, storageKey, key);
    if (ctx.isHere(identifier)) ctx.onIntentChanged(identifier);
    throw error;
  }
  clearBulkIntentIn(storage, storageKey, key);
  if (ctx.isHere(identifier)) ctx.onIntentChanged(identifier);
  // The jobs belong to their article wherever the editor is now; the store
  // keeps following them, and the tray opens only if it is still on screen.
  if (!operationNotice.isCurrent()) return;
  for (const job of jobs) translationJobs.ingest(identifier, job);
  void translationJobs.refresh(identifier);
  if (!ctx.isHere(identifier)) return;
  translationJobs.openTray(identifier);
  operationNotice.success(
    t(
      "translationJobs.startedToast",
      "Translating into {languages}. Keep writing if you like — the editor asks before any save that would stop them.",
      { languages: ctx.list(languages) },
    ),
  );
}
