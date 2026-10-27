/**
 * Buying an AI translation with 2Z — the client half of  Part 6.
 *
 * The endpoints (`quote`, `purchase`, `status`) have been on `main` since
 * `be1a9a49`; nothing here re-derives a URL, and the orchestration lives in
 * the editor page next to the autosave it has to coordinate with. What lives
 * HERE is the part that is pure, that a node test can pin, and that is easy to
 * get subtly wrong:
 *
 * 1. **Turning a refusal into a sentence a creator can act on.** The API
 *    answers a dozen distinct `code`s across 400/402/409/503. Rendering them
 *    as one "something went wrong" is how 's silent 409 happened: a
 *    creator clicking Translate on an already-published language saw nothing
 *    at all. Every code below names what to do next.
 * 2. **The idempotency key.** orval emits no code for `in: header` parameters
 *    (see CLAUDE.md), so `Idempotency-Key` can only reach the wire if a call
 *    site puts it there. Minting it in one place, and holding it steady across
 *    retries of ONE purchase, is the entire double-charge defence.
 *
 * 2Z are platform credits. Nothing here calls them money, and no copy in the
 * catalogs may either.
 */

/** How often to ask what became of a purchase, in milliseconds. */
export const TRANSLATION_POLL_INTERVAL_MS = 3000;

/**
 * How long to keep polling before saying "it is still running", in ms.
 *
 * Not a timeout on the translation — the job outlives this, and its money is
 * settled either way: it delivers, or the `reap_translation_charges` sweep
 * refunds it. This is only how long the editor watches before telling the
 * creator to come back later, so the tab is not pinned to a long article.
 *
 * Matched to the server's own `DOCUMENT_TIMEOUT_SECONDS` (900s) so a job that
 * runs to the provider's limit is still being watched when it lands. It
 * deliberately does NOT try to cover the queue backlog, which is unbounded in
 * principle: past this point the panel is refreshed and the creator is told
 * where to look. What keeps a stale panel from turning into a second charge is
 * not a longer poll — it is that the price screen re-reads the variants before
 * it offers anything, and names the draft it would replace.
 */
export const TRANSLATION_POLL_TIMEOUT_MS = 15 * 60 * 1000;

/** A fresh UUIDv4. The server rejects anything else (`_idempotency_key`). */
export function newIdempotencyKey() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  // Node 18 and every browser we support have `randomUUID`; this exists so a
  // stripped environment degrades to a valid v4 rather than to no key at all,
  // which the server would reject and which would silently disable the
  // double-charge protection if it ever became optional.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

/**
 * The fields the SERVER binds a translation purchase to, in the order it
 * names them — `charges.request_fingerprint(zpage_id, language,
 * source_digest, price)` in `py/dj/apps/g12f/translation/charges.py`, called
 * from `ZPageTranslationView.post`. A test reads that function and fails if
 * this list and it ever disagree, because the two identities MUST cover the
 * same facts: a fact the server fingerprints and the client does not
 * is one whose change makes the client re-send the old key for what the
 * server now considers a different request — 409 `idempotency_mismatch`, on
 * every later attempt, with nothing ever clearing the key.
 *
 * The keys are the server's names; the values say what the client uses.
 */
export const TRANSLATION_PURCHASE_FINGERPRINT_FIELDS = Object.freeze({
  zpage: "identifier",
  language: "language",
  source_digest: "quote.source_digest",
  price: "quote.price",
});

/**
 * The persisted identity of ONE translation purchase decision — the thing the
 * `Idempotency-Key` is minted for and retired with.
 *
 * It names everything the server's fingerprint names. `source_digest` is the
 * one that was missing: the article's body is in the server's
 * identity, so editing the article and buying the same language at the same
 * whole-number price is a NEW purchase server-side. Without the digest here
 * the client rebuilt the same identity, re-sent the same key, and the server
 * correctly answered 409 `idempotency_mismatch` — and kept answering it,
 * because a 409 does not clear the key. Translation stayed wedged for that
 * article until the price happened to change.
 *
 * `actor` is the authenticated owner. It is not in the server fingerprint
 * because the server scopes keys per user already; the client needs it
 * because localStorage is per browser.
 *
 * @param {{ actor: string, identifier: string, language: string, quote: { price: number | string, source_digest: string } }} purchase
 * @returns {{ actor: string, action: "translation", resource: string, amount: string, intent: "ai_translation" }}
 */
export function translationPurchaseIdentity({
  actor,
  identifier,
  language,
  quote,
}) {
  // A quote with no digest cannot be bound to the server's identity; minting
  // a key for it would recreate the wedge this function exists to prevent.
  if (typeof quote?.source_digest !== "string" || !quote.source_digest) {
    throw new TypeError(
      "translation purchase: the quote has no source_digest to bind the key to",
    );
  }
  return {
    actor,
    action: "translation",
    resource: `${identifier}|${language}|${quote.source_digest}`,
    amount: String(quote.price),
    intent: "ai_translation",
  };
}

/**
 * The identity BUILDS BEFORE  used for the same decision: article and
 * language, no digest.
 *
 * It exists so `intentIdempotencyKey(..., { supersedes })` can carry an
 * unresolved pre-upgrade purchase into the new bucket instead of abandoning
 * it — a rename alone would mint a fresh UUID for a retry whose original may
 * already have committed, and charge it twice (codex adversarial review,
 * HIGH). Nothing else may use it.
 *
 * @param {{ actor: string, identifier: string, language: string, quote: { price: number | string } }} purchase
 * @returns {{ actor: string, action: "translation", resource: string, amount: string, intent: "ai_translation" }}
 */
export function translationPurchaseLegacyIdentity({
  actor,
  identifier,
  language,
  quote,
}) {
  return {
    actor,
    action: "translation",
    resource: `${identifier}|${language}`,
    amount: String(quote.price),
    intent: "ai_translation",
  };
}

/**
 * The `code` the API put on a refusal, or `null`.
 *
 * Branch on this, never on the prose — the contract says so, and the prose is
 * English-only while this UI is not.
 *
 * @param {unknown} error
 * @returns {string | null}
 */
export function translationErrorCode(/** @type {unknown} */ error) {
  const data = /** @type {{data?: unknown}} */ (error)?.data;
  if (
    data &&
    typeof data === "object" &&
    typeof (/** @type {any} */ (data).code) === "string"
  ) {
    return /** @type {any} */ (data).code;
  }
  return null;
}

/** The server's own prose for a refusal, or `null`. */
export function translationErrorDetail(/** @type {unknown} */ error) {
  const data = /** @type {{data?: unknown}} */ (error)?.data;
  if (
    data &&
    typeof data === "object" &&
    typeof (/** @type {any} */ (data).error) === "string"
  ) {
    return /** @type {any} */ (data).error;
  }
  return null;
}

/**
 * Every refusal, as a localized sentence that says what to do next.
 *
 * Falls back to the server's own message rather than to a generic apology: a
 * code we have not localized yet is still a code whose English prose is
 * actionable, and swallowing it would be strictly worse for the creator than
 * showing it. The last resort is the generic line.
 *
 * @param {unknown} error       the thrown `ApiError`
 * @param {object} options
 * @param {(code: string, fallback: string, params?: Record<string, string | number>) => string} options.t
 * @param {string} options.language   the target language's display name
 * @returns {string}
 */
export function translationPurchaseError(error, { t, language }) {
  const code = translationErrorCode(error);
  const status = /** @type {{status?: number}} */ (error)?.status ?? 0;

  switch (code) {
    // ---- the creator can fix this, and the fix is named ------------------
    case "published_variant_limit":
      //. Refused at QUOTE time too, so this is normally unreachable from
      // the button — it is what a creator sees when the last slot filled while
      // the confirmation dialog was open.
      return t(
        "editor.translateAiErrorPublishedLimit",
        "This article already has as many published translations as it can hold, so a new one could not be published. Unpublish or delete one first — nothing was charged.",
      );
    case "draft_variant_limit":
      //. Refused at quote time and purchase time when the draft working
      // set is full.
      return t(
        "editor.translateAiErrorDraftLimit",
        "This article already has as many draft translations as it can hold. Delete or publish an existing draft first — nothing was charged.",
      );
    case "translation_too_long":
      //. Refused at quote time: the article (or one paragraph of it) is
      // too long to translate into this language inside the job's time
      // limit, so it is never sold. The server's prose says which of the two.
      return t(
        "editor.translateAiErrorTooLong",
        "This article is too long to translate into {language} in one go. Nothing was charged — split it into shorter articles, or break up very long paragraphs, then ask for a new price.",
        { language },
      );
    case "variant_published":
      // 's silent 409, given a voice.
      return t(
        "editor.translateAiErrorVariantPublished",
        "The {language} translation is published, and an AI translation never overwrites live content. Unpublish or delete it first — nothing was charged.",
        { language },
      );
    case "insufficient_funds":
      return t(
        "editor.translateAiErrorInsufficient",
        "You do not have enough 2Z for this translation. Nothing was charged.",
      );
    case "source_changed":
      return t(
        "editor.translateAiErrorSourceChanged",
        "The article changed after this quote. Nothing was charged for this attempt; review the new quote before buying.",
      );
    case "price_changed":
      return t(
        "editor.translateAiErrorPriceChanged",
        "The price changed while you were deciding — the article was edited. Nothing was charged; ask for a new price.",
      );
    case "translation_in_progress": {
      // an account runs several at once; this code then means the
      // ACCOUNT's cap, and the refusal says how many are running. Without
      // those numbers it is the legacy one-at-a-time backend.
      const data = /** @type {{data?: any}} */ (error)?.data;
      if (typeof data?.max_in_flight === "number")
        return t(
          "translationJobs.capReached",
          "{inFlight} translations are already running for your account, and {max} is the most at once. Start these when some finish — nothing was charged.",
          {
            inFlight: data.in_flight ?? data.max_in_flight,
            max: data.max_in_flight,
          },
        );
      return t(
        "editor.translateAiErrorInProgress",
        "One translation at a time. Wait for the current one to finish, then buy the next — nothing was charged.",
      );
    }
    case "same_language":
      return t(
        "editor.translateAiErrorSameLanguage",
        "This article is already written in {language}.",
        { language },
      );
    case "not_translatable":
      return t(
        "editor.translateAiErrorNotTranslatable",
        "We do not sell AI translations into {language} yet. You can still write this one by hand.",
        { language },
      );
    case "empty_article":
      return t(
        "editor.translateAiErrorEmptyArticle",
        "There is nothing to translate yet. Write the article first.",
      );
    case "unknown_source_language":
      return t(
        "editor.translateAiErrorUnknownSource",
        "This article's own language has not been determined yet, so there is nothing to translate from. Set it and try again.",
      );

    // ---- ours, not theirs; nothing was charged ---------------------------
    case "translation_backlog":
    case "translation_unavailable":
      return t(
        "editor.translateAiErrorUnavailable",
        "AI translation is busy right now. Try again in a few minutes — nothing was charged.",
      );

    // ---- retry plumbing --------------------------------------------------
    case "request_in_progress":
      return t(
        "editor.translateAiErrorPending",
        "Your purchase is still being decided. Check the Translations panel again shortly — this is never a second charge.",
      );
    case "idempotency_mismatch":
      return t(
        "editor.translateAiErrorRetryKey",
        "That purchase could not be retried safely. Reload the editor and try again — nothing was charged twice.",
      );
    default:
      break;
  }

  if (status === 401 || status === 403 || status === 404) {
    return t(
      "editor.translateAiErrorForbidden",
      "You are not allowed to buy a translation for this article.",
    );
  }

  const detail = translationErrorDetail(error);
  if (detail !== null) {
    // A code we have not localized yet, but a refusal the server chose to
    // make — its prose is actionable and throwing it away is worse.
    return detail;
  }

  if (isAmbiguousOutcome(error)) {
    // The one case where "nothing was charged" is a lie we cannot detect.
    return t(
      "editor.translateAiErrorUnknown",
      "We could not tell whether that purchase went through. Do not buy it again yet — check the Translations panel, and if 2Z were spent the translation is on its way or they come back.",
    );
  }

  return t(
    "editor.translateAiErrorFailed",
    "The translation could not be bought. Nothing was charged — try again.",
  );
}

/**
 * Did this failure leave the purchase's outcome genuinely unknown?
 *
 * A structured refusal (`{code, error}` with a 4xx/5xx the server chose) is a
 * decision: the money did not move and the endpoint says so. A transport
 * failure, a 5xx with no body, or a response that could not be parsed is NOT.
 * Django can commit the debit and the 202 receipt and then have the connection
 * reset — from here that is indistinguishable from never having arrived.
 *
 * Telling a creator "nothing was charged" in that case is the one message that
 * can be actively false, and it is the message most likely to make them click
 * Buy again. So this case gets its own copy, and the caller recovers the truth
 * from `GET.../translate/` rather than guessing. (codex adversarial review.)
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAmbiguousOutcome(error) {
  if (translationErrorCode(error) !== null) return false;
  const status = /** @type {{status?: number}} */ (error)?.status ?? 0;
  // 0 is "never got an HTTP answer" — DNS, reset, offline, CORS, abort.
  // >=500 with no code is a server that fell over somewhere unknown, possibly
  // after committing. Everything else with a real status is a decision.
  return status === 0 || status >= 500;
}

/**
 * Has the purchase settled, and how?
 *
 * `queued` is the only non-terminal state the contract defines. Treating an
 * unrecognized value as terminal would strand a creator on a spinner; treating
 * it as pending would spin forever. Unknown means terminal-unknown: stop
 * watching, keep the money story ("delivered, refunded or settled, never
 * neither") and let the panel show what actually landed.
 *
 * `settled` (tuzi#1908) is a failure in which PART of the charge was kept,
 * covering provider work that had already been done and billed to us when the
 * buyer changed the article under their own paid job again. It is terminal, and
 * it is a distinct state precisely because "all your 2Z came back" must not be
 * said about it.
 *
 * @param {{status?: string} | null | undefined} job
 * @returns {"queued" | "delivered" | "refunded" | "settled" | "unknown"}
 */
export function translationJobState(job) {
  const status = job?.status;
  if (status === "queued") return "queued";
  if (status === "delivered") return "delivered";
  if (status === "refunded") return "refunded";
  if (status === "settled") return "settled";
  return "unknown";
}

/**
 * Which refund terms this build's purchase screen displays (tuzi#1908).
 *
 * Sent with every purchase, and the server bills a failure only when it matches
 * the policy it knows. That is not ceremony: an editor tab opened before the
 * deploy still shows the old, unconditional "every 2Z comes back" promise and
 * can still buy, and a creator may only be charged against terms they were
 * actually shown. Omitting the field is the legacy contract — refund
 * everything — so an older client is protected by saying nothing.
 *
 * **Bump this only together with the dialog copy that states the terms.**
 * `settlement.METERED_POLICY_VERSION` on the backend is the other half.
 *
 * @type {number}
 */
export const SETTLEMENT_POLICY_VERSION = 1;

/**
 * Every terminal status. The single list every "stop polling / stop spinning"
 * decision must branch on.
 *
 * It exists because the two call sites in `routes/edit/+page.svelte` each had
 * their own inline `["delivered", "refunded"]`, and adding a fourth terminal
 * status to the contract without finding both of them leaves a creator watching
 * a spinner that will never stop for a job that is already over.
 *
 * @type {readonly string[]}
 */
export const TERMINAL_TRANSLATION_STATUSES = Object.freeze([
  "delivered",
  "refunded",
  "settled",
]);

/**
 * Has this job finished, one way or another?
 *
 * @param {{status?: string} | null | undefined} job
 * @returns {boolean}
 */
export function isTerminalTranslationJob(job) {
  return TERMINAL_TRANSLATION_STATUSES.includes(job?.status ?? "");
}

const NO_CHARGE_CODES = new Set([
  "not_translatable",
  "unknown_source_language",
  "same_language",
  "empty_article",
  "translation_unavailable",
  "variant_published",
  "translation_in_progress",
  "translation_backlog",
  "published_variant_limit",
  "draft_variant_limit",
  //decided from the quote before the debit, like a variant limit.
  "translation_too_long",
  "insufficient_funds",
  "source_changed",
  "price_changed",
  "idempotency_mismatch",
  // The bulk purchase's 400s: each is decided before the key is
  // claimed, so nothing was charged and the key is not burnt. Keeping the key
  // on them held autosave forever behind a purchase that never happened.
  "too_many_languages",
  "invalid_request",
  "invalid_language",
  "duplicate_language",
  "idempotency_key_required",
  "items_refused",
]);

/**
 * Refusals that PROVE no 2Z moved, so a purchase's idempotency key may be
 * retired and the next attempt may mint a fresh one.
 *
 * Every other failure keeps the key — a lost response, a 5xx, a CSRF 403, a
 * 429, `request_in_progress` — because from here those are indistinguishable
 * from "the debit committed and only the answer was lost", and a fresh key is
 * then a second charge. The bulk dialog dropped its key on any of those until
 * the codex adversarial review of  caught it.
 *
 * A 409 carrying `items` is the bulk purchase's all-or-nothing refusal naming
 * the lines that cannot be bought: nothing was charged for any of them.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isNoChargeRefusal(error) {
  const status = /** @type {{status?: number}} */ (error)?.status ?? 0;
  const data = /** @type {{data?: any}} */ (error)?.data;
  if (status === 409 && Array.isArray(data?.items) && data.items.length)
    return true;
  return NO_CHARGE_CODES.has(translationErrorCode(error) ?? "");
}
