/**
 * The KYC intake state machine — pure, so it can be unit tested.
 *
 * The single most important property of this flow is that it is **resumable**:
 * the authoritative state lives on the server (`UserProfile` plus the stored
 * files), never in component state. A refresh, a new device, or a session that
 * died halfway through the live-photo step all resolve the same way — read the
 * server state, derive which steps are done, and drop the applicant on the
 * first one that is not. Nothing here reads `window`, `document` or `fetch`,
 * so it runs identically during SSR, in the browser, and in `node --test`.
 *
 * @typedef {"NEW"|"PENDING"|"APPROVED"|"REJECTED"} ApplicationStatus
 *
 * @typedef {object} KycServerState
 * @property {ApplicationStatus} applicationStatus
 * @property {boolean|null} isUs           US person for tax purposes
 * @property {boolean|null} isIndividual   individual rather than an entity
 * @property {boolean} hasTaxForm          a tax form PDF is stored
 * @property {string} signature            the typed electronic signature
 * @property {boolean} hasIdFront
 * @property {boolean} hasIdBack
 * @property {boolean} hasAdditionalDocument
 * @property {boolean} hasLivePhoto
 * @property {string} rejectionReason
 */

/**
 * Step ids, in the order they are presented. `intro` is not a data step; it is
 * where the consent and "what we collect" copy lives, and it is always
 * complete so a returning applicant is never sent back to read it again.
 */
export const KYC_STEPS = /** @type {const} */ ([
  "intro",
  "basicInfo",
  "taxForm",
  "identity",
  "livePhoto",
  "signature",
  "review",
]);

/** Application statuses in which the applicant may still change their data. */
export const EDITABLE_STATUSES = /** @type {const} */ (["NEW"]);

/**
 * Blank IRS forms. These are the canonical irs.gov PDFs — we link out rather
 * than mirroring them, so an applicant is never handed a stale revision by us.
 */
export const TAX_FORMS = {
  "W-9": {
    id: "W-9",
    url: "https://www.irs.gov/pub/irs-pdf/fw9.pdf",
  },
  "W-8BEN": {
    id: "W-8BEN",
    url: "https://www.irs.gov/pub/irs-pdf/fw8ben.pdf",
  },
  "W-8BEN-E": {
    id: "W-8BEN-E",
    url: "https://www.irs.gov/pub/irs-pdf/fw8bene.pdf",
  },
};

/**
 * Which tax form the applicant owes, from the two basic-info answers.
 *
 * Mirrors `TaxFormUploadView`, which picks the W9 / W8BEN / W8BENE row from
 * `profile.is_us` and `profile.is_individual` and ignores anything the client
 * says. If these two ever disagree, the server wins and the applicant has
 * uploaded the wrong form — so keep them in step.
 *
 * @param {{isUs: boolean|null, isIndividual: boolean|null}} answers
 * @returns {{id: string, url: string}|null} null until both answers are given
 */
export function requiredTaxForm({ isUs, isIndividual }) {
  if (isUs === null || isUs === undefined) return null;
  if (isIndividual === null || isIndividual === undefined) return null;
  if (isUs) return TAX_FORMS["W-9"];
  return isIndividual ? TAX_FORMS["W-8BEN"] : TAX_FORMS["W-8BEN-E"];
}

/** @param {ApplicationStatus} status */
export function isEditable(status) {
  return EDITABLE_STATUSES.includes(/** @type {never} */ (status));
}

/**
 * Per-step completion, derived only from server state.
 *
 * `identity` deliberately requires the FRONT of the ID only. The back and the
 * supporting document are optional in `IdentityDocumentsView` (it uploads
 * whichever fields are present) and the classic stepper labelled them
 * "(Optional)" — requiring them here would lock out anyone holding a
 * single-sided document.
 *
 * @param {KycServerState} state
 * @returns {Record<typeof KYC_STEPS[number], boolean>}
 */
export function stepCompletion(state) {
  const basicInfo =
    state.isUs !== null &&
    state.isUs !== undefined &&
    state.isIndividual !== null &&
    state.isIndividual !== undefined;

  return {
    intro: true,
    basicInfo,
    taxForm: basicInfo && state.hasTaxForm,
    identity: state.hasIdFront,
    livePhoto: state.hasLivePhoto,
    signature: Boolean(state.signature && state.signature.trim()),
    review: state.applicationStatus !== "NEW",
  };
}

/**
 * The step to open on load: the first incomplete one.
 *
 * When everything is done we land on `review` rather than running off the end
 * of the list — that is the "you have finished, submit it" screen, and it is
 * also where a PENDING/APPROVED/REJECTED applicant belongs since there is
 * nothing left for them to fill in.
 *
 * @param {KycServerState} state
 * @returns {number} index into KYC_STEPS
 */
export function resumeStepIndex(state) {
  if (!isEditable(state.applicationStatus)) {
    return KYC_STEPS.indexOf("review");
  }

  const completion = stepCompletion(state);
  const firstIncomplete = KYC_STEPS.findIndex(
    (step) => step !== "review" && !completion[step],
  );

  return firstIncomplete === -1 ? KYC_STEPS.indexOf("review") : firstIncomplete;
}

/**
 * Whether the applicant may submit for review.
 *
 * Every data step must be complete AND the application must still be editable
 * — `ChangeApplicationStatusView` only accepts NEW -> PENDING (and
 * APPROVED -> NEW), so offering the button in any other state would just
 * produce a 400 the applicant cannot act on.
 *
 * @param {KycServerState} state
 */
export function canSubmit(state) {
  if (!isEditable(state.applicationStatus)) return false;
  const completion = stepCompletion(state);
  return KYC_STEPS.every((step) => step === "review" || completion[step]);
}

/**
 * How far through the applicant is, for the progress indicator. Counts the
 * data steps only — `intro` is free and `review` is the destination.
 *
 * @param {KycServerState} state
 * @returns {{done: number, total: number, percent: number}}
 */
export function completionProgress(state) {
  const completion = stepCompletion(state);
  const dataSteps = KYC_STEPS.filter(
    (step) => step !== "intro" && step !== "review",
  );
  const done = dataSteps.filter((step) => completion[step]).length;

  return {
    done,
    total: dataSteps.length,
    percent: Math.round((done / dataSteps.length) * 100),
  };
}

/**
 * Normalize whatever the API returned into `KycServerState`.
 *
 * Written defensively because three separate endpoints feed it and any of
 * them can fail independently — a 500 on the identity-documents read must
 * degrade to "nothing uploaded yet" rather than blank the page.
 *
 * @param {any} input
 * @returns {KycServerState}
 */
export function toServerState(input) {
  const profile = input?.profile || {};
  const documents = input?.documents || {};

  return {
    applicationStatus: /** @type {ApplicationStatus} */ (
      profile.application_status || "NEW"
    ),
    isUs: profile.is_us ?? null,
    isIndividual: profile.is_individual ?? null,
    hasTaxForm: Boolean(input?.hasTaxForm),
    signature:
      typeof profile.tax_form_signature === "string"
        ? profile.tax_form_signature
        : (input?.signature ?? ""),
    hasIdFront: Boolean(documents.id_front),
    hasIdBack: Boolean(documents.id_back),
    hasAdditionalDocument: Boolean(documents.additional_document),
    hasLivePhoto: Boolean(documents.live_photo),
    rejectionReason: profile.rejection_reason || "",
  };
}
