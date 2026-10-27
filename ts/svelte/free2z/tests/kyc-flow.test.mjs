import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  KYC_STEPS,
  canSubmit,
  completionProgress,
  isEditable,
  requiredTaxForm,
  resumeStepIndex,
  stepCompletion,
  toServerState,
} from "../src/lib/kyc/state.js";
import {
  blobToLivePhotoFile,
  cameraProblemKey,
  cameraSupported,
  classifyCameraError,
  livePhotoFilename,
  stopStream,
} from "../src/lib/kyc/camera.js";
import {
  MAX_UPLOAD_BYTES,
  IDENTITY_PHOTO_EXTENSIONS,
  TAX_FORM_EXTENSIONS,
  preflightUpload,
  readErrorDetail,
} from "../src/lib/kyc/uploads.js";

const livePhotoSource = await readFile(
  new URL("../src/lib/components/kyc/KycLivePhoto.svelte", import.meta.url),
  "utf8",
);
const documentFieldSource = await readFile(
  new URL("../src/lib/components/kyc/KycDocumentField.svelte", import.meta.url),
  "utf8",
);
const pageSource = await readFile(
  new URL(
    "../src/routes/[username]/dashboard/kyc/+page.svelte",
    import.meta.url,
  ),
  "utf8",
);
const pageServerSource = await readFile(
  new URL(
    "../src/routes/[username]/dashboard/kyc/+page.server.ts",
    import.meta.url,
  ),
  "utf8",
);
const layoutSource = await readFile(
  new URL("../src/routes/+layout.svelte", import.meta.url),
  "utf8",
);

/** A profile that has done nothing yet. */
function blankState(overrides = {}) {
  return {
    applicationStatus: "NEW",
    isUs: null,
    isIndividual: null,
    hasTaxForm: false,
    signature: "",
    hasIdFront: false,
    hasIdBack: false,
    hasAdditionalDocument: false,
    hasLivePhoto: false,
    rejectionReason: "",
    ...overrides,
  };
}

/** A profile with every data step done, ready to submit. */
function completeState(overrides = {}) {
  return blankState({
    isUs: true,
    isIndividual: true,
    hasTaxForm: true,
    signature: "Ada Lovelace",
    hasIdFront: true,
    hasLivePhoto: true,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Which tax form is owed
// ---------------------------------------------------------------------------

test("the required tax form follows the same rule as TaxFormUploadView", () => {
  // The server picks W9 / W8BEN / W8BENE from these two booleans and ignores
  // anything the client says, so a disagreement here means the applicant
  // uploads the wrong form and gets rejected by a human weeks later.
  assert.equal(requiredTaxForm({ isUs: true, isIndividual: true }).id, "W-9");
  assert.equal(requiredTaxForm({ isUs: true, isIndividual: false }).id, "W-9");
  assert.equal(
    requiredTaxForm({ isUs: false, isIndividual: true }).id,
    "W-8BEN",
  );
  assert.equal(
    requiredTaxForm({ isUs: false, isIndividual: false }).id,
    "W-8BEN-E",
  );
});

test("no tax form is named until both questions are answered", () => {
  assert.equal(requiredTaxForm({ isUs: null, isIndividual: true }), null);
  assert.equal(requiredTaxForm({ isUs: true, isIndividual: null }), null);
  assert.equal(requiredTaxForm({ isUs: null, isIndividual: null }), null);
});

test("every named form links to irs.gov over https", () => {
  for (const answers of [
    { isUs: true, isIndividual: true },
    { isUs: false, isIndividual: true },
    { isUs: false, isIndividual: false },
  ]) {
    const form = requiredTaxForm(answers);
    assert.match(form.url, /^https:\/\/www\.irs\.gov\//);
  }
});

// ---------------------------------------------------------------------------
// Resumability — the property the whole flow is built around
// ---------------------------------------------------------------------------

test("a brand-new applicant resumes at the first data step, not the intro", () => {
  // The intro is copy, not data. Sending a returning applicant back through it
  // every time is the difference between "resumable" and "restartable".
  assert.equal(KYC_STEPS[resumeStepIndex(blankState())], "basicInfo");
});

test("resume lands on the first incomplete step for every partial state", () => {
  const cases = [
    [blankState({ isUs: true, isIndividual: false }), "taxForm"],
    [
      blankState({ isUs: true, isIndividual: false, hasTaxForm: true }),
      "identity",
    ],
    [
      blankState({
        isUs: true,
        isIndividual: false,
        hasTaxForm: true,
        hasIdFront: true,
      }),
      "livePhoto",
    ],
    [
      blankState({
        isUs: true,
        isIndividual: false,
        hasTaxForm: true,
        hasIdFront: true,
        hasLivePhoto: true,
      }),
      "signature",
    ],
    [completeState(), "review"],
  ];

  for (const [state, expected] of cases) {
    assert.equal(
      KYC_STEPS[resumeStepIndex(state)],
      expected,
      `expected to resume at ${expected}`,
    );
  }
});

test("resume is stable — re-deriving from the same server state does not drift", () => {
  // This is what a refresh does. If it were not idempotent, reloading would
  // walk the applicant forwards or backwards through the flow.
  const state = blankState({ isUs: false, isIndividual: true });
  const first = resumeStepIndex(state);
  assert.equal(resumeStepIndex(state), first);
  assert.equal(resumeStepIndex({ ...state }), first);
});

test("a submitted, approved or rejected application resumes on the review step", () => {
  for (const status of ["PENDING", "APPROVED", "REJECTED"]) {
    const state = blankState({ applicationStatus: status });
    assert.equal(
      KYC_STEPS[resumeStepIndex(state)],
      "review",
      `${status} should land on review`,
    );
  }
});

test("a half-finished application that was submitted anyway still lands on review", () => {
  // Nothing stops an admin moving a half-filled profile to PENDING. The
  // applicant must not be dropped into an editable step they cannot save.
  const state = blankState({ applicationStatus: "PENDING", isUs: true });
  assert.equal(KYC_STEPS[resumeStepIndex(state)], "review");
});

test("optional documents never hold the flow up", () => {
  // id_back and additional_document are optional server-side; requiring them
  // would lock out anyone with a single-sided document.
  const state = completeState({
    hasIdBack: false,
    hasAdditionalDocument: false,
  });
  assert.equal(stepCompletion(state).identity, true);
  assert.equal(canSubmit(state), true);
});

test("a whitespace-only signature does not count as signed", () => {
  assert.equal(
    stepCompletion(blankState({ signature: "   " })).signature,
    false,
  );
  assert.equal(canSubmit(completeState({ signature: "  " })), false);
});

test("basic info needs BOTH answers, and false is a real answer", () => {
  assert.equal(stepCompletion(blankState({ isUs: false })).basicInfo, false);
  assert.equal(
    stepCompletion(blankState({ isUs: false, isIndividual: false })).basicInfo,
    true,
  );
});

// ---------------------------------------------------------------------------
// A tax form belongs to a classification, and a signature belongs to a document
//
// Both of these were found by the codex adversarial review on this PR. The
// underlying trap is the same: `hasTaxForm` and `signature` are single scalars,
// but the thing each of them refers to can change underneath.
// ---------------------------------------------------------------------------

test("changing classification re-reads the tax form instead of assuming it survived", () => {
  // TaxFormUploadView writes to W9 / W8BEN / W8BENE from is_us and
  // is_individual, and GetTaxFormFileView reads back whichever the *current*
  // answers select. A W-9 uploaded as a US person is simply not there once the
  // applicant says they are a foreign individual — so carrying hasTaxForm
  // across the change would mark the step complete and let them submit an
  // application whose required form does not exist.
  const save = pageSource.slice(
    pageSource.indexOf("async function submitBasicInfo"),
    pageSource.indexOf("async function handleTaxFormFile"),
  );

  assert.ok(
    save.includes("fetchTaxFormFile()"),
    "submitBasicInfo must re-read the tax form after the classification changes",
  );
  assert.ok(
    save.includes("hasTaxForm: Boolean(taxFormFile?.file)"),
    "hasTaxForm must come from the server after a classification change",
  );
  assert.ok(
    save.indexOf("fetchTaxFormFile()") < save.indexOf("goToStep"),
    "the re-read must happen before advancing to the tax-form step",
  );
});

test("replacing or removing the tax form invalidates the signature that covered it", () => {
  // tax_form_signature lives on the profile, not on the tax form. Without this
  // the typed name outlives the document it signed, and the review step happily
  // reports "Signed as..." about a PDF nobody signed.
  assert.ok(pageSource.includes("async function invalidateSignature()"));
  assert.ok(pageSource.includes('await saveSignature("")'));

  const upload = pageSource.slice(
    pageSource.indexOf("async function handleTaxFormFile"),
    pageSource.indexOf("async function removeTaxForm"),
  );
  const remove = pageSource.slice(
    pageSource.indexOf("async function removeTaxForm"),
    pageSource.indexOf("async function invalidateSignature"),
  );

  assert.ok(upload.includes("invalidateSignature()"), "upload must invalidate");
  assert.ok(remove.includes("invalidateSignature()"), "delete must invalidate");
});

test("a cleared signature makes the application unsubmittable again", () => {
  // The behavioural half of the check above: whatever the UI does, an empty
  // signature must reopen the signature step rather than sail through review.
  const resigned = completeState({ signature: "" });
  assert.equal(canSubmit(resigned), false);
  assert.equal(KYC_STEPS[resumeStepIndex(resigned)], "signature");
});

// ---------------------------------------------------------------------------
// Submission gating
// ---------------------------------------------------------------------------

test("an incomplete application cannot be submitted", () => {
  assert.equal(canSubmit(blankState()), false);
  assert.equal(canSubmit(completeState({ hasTaxForm: false })), false);
  assert.equal(canSubmit(completeState({ hasIdFront: false })), false);
  assert.equal(canSubmit(completeState({ hasLivePhoto: false })), false);
});

test("only a NEW application can be submitted", () => {
  // ChangeApplicationStatusView accepts NEW -> PENDING and APPROVED -> NEW and
  // 400s everything else, so offering submit elsewhere shows an error the
  // applicant cannot act on.
  assert.equal(canSubmit(completeState()), true);
  for (const status of ["PENDING", "APPROVED", "REJECTED"]) {
    assert.equal(
      canSubmit(completeState({ applicationStatus: status })),
      false,
      `${status} must not be submittable`,
    );
  }
});

test("editability matches the server's can_edit()", () => {
  assert.equal(isEditable("NEW"), true);
  for (const status of ["PENDING", "APPROVED", "REJECTED"]) {
    assert.equal(isEditable(status), false);
  }
});

test("progress counts the five data steps only", () => {
  assert.deepEqual(completionProgress(blankState()), {
    done: 0,
    total: 5,
    percent: 0,
  });
  assert.deepEqual(completionProgress(completeState()), {
    done: 5,
    total: 5,
    percent: 100,
  });
});

// ---------------------------------------------------------------------------
// Normalizing the API payloads
// ---------------------------------------------------------------------------

test("server state survives endpoints that failed independently", () => {
  // Each of the four reads in +page.server.ts can fail on its own; a null must
  // read as "nothing there yet", never crash the derivation.
  const state = toServerState({ profile: null, documents: null });
  assert.equal(state.applicationStatus, "NEW");
  assert.equal(state.isUs, null);
  assert.equal(state.hasIdFront, false);
  assert.equal(state.signature, "");
});

test("server state reads document presence, not URLs", () => {
  const state = toServerState({
    profile: {
      application_status: "REJECTED",
      is_us: false,
      is_individual: false,
      rejection_reason: "The back of the ID is cut off.",
      tax_form_signature: "Ada Lovelace",
    },
    hasTaxForm: true,
    documents: { id_front: true, live_photo: true },
  });

  assert.equal(state.applicationStatus, "REJECTED");
  assert.equal(state.isUs, false);
  assert.equal(state.isIndividual, false);
  assert.equal(state.rejectionReason, "The back of the ID is cut off.");
  assert.equal(state.hasIdFront, true);
  assert.equal(state.hasIdBack, false);
});

// ---------------------------------------------------------------------------
// SSR safety of the camera step
// ---------------------------------------------------------------------------

test("cameraSupported is false under SSR, where there is no navigator", () => {
  // This test runs in plain Node — the same environment adapter-node renders
  // in. If this ever throws instead of returning false, the KYC page 500s.
  assert.equal(typeof globalThis.navigator?.mediaDevices, "undefined");
  assert.equal(cameraSupported(), false);
});

test("cameraSupported is false for every partial browser shape", () => {
  assert.equal(cameraSupported({}), false);
  assert.equal(cameraSupported({ navigator: null }), false);
  assert.equal(cameraSupported({ navigator: {} }), false);
  assert.equal(cameraSupported({ navigator: { mediaDevices: {} } }), false);
  assert.equal(
    cameraSupported({ navigator: { mediaDevices: { getUserMedia: null } } }),
    false,
  );
});

test("cameraSupported is true only with a real getUserMedia", () => {
  assert.equal(
    cameraSupported({
      navigator: { mediaDevices: { getUserMedia: () => {} } },
    }),
    true,
  );
});

test("the camera module imports cleanly in Node and touches no browser global", async () => {
  // Importing is the test: a top-level `navigator.` or `document.` reference
  // would have thrown before this line.
  const module = await import("../src/lib/kyc/camera.js");
  assert.equal(typeof module.cameraSupported, "function");
  assert.equal(module.LIVE_PHOTO_CONSTRAINTS.audio, false);
  assert.equal(module.LIVE_PHOTO_CONSTRAINTS.video.facingMode, "user");
});

test("the live-photo component reads mediaDevices only inside a handler or onMount", () => {
  const script = livePhotoSource.slice(
    livePhotoSource.indexOf("<script>"),
    livePhotoSource.indexOf("</script>"),
  );

  // `canUseCamera` must start false so the SSR pass renders the fallback.
  assert.match(script, /let canUseCamera = false;/);
  // The only capability probe is the one inside onMount.
  assert.match(
    script,
    /onMount\(\(\) => \{\s*canUseCamera = cameraSupported\(\);/,
  );
  // getUserMedia is called from openCamera(), which is a click handler.
  const gumIndex = script.indexOf("navigator.mediaDevices.getUserMedia");
  assert.ok(gumIndex > script.indexOf("async function openCamera"));
});

test("the live-photo step always offers the upload fallback", () => {
  // Desktop with no camera, and a browser where the applicant clicked Block,
  // are both ordinary. Neither may be a dead end.
  assert.ok(livePhotoSource.includes('type="file"'));
  assert.ok(livePhotoSource.includes("dashboard.kyc.livePhoto.upload"));
  // The camera button is the conditional one, not the upload button.
  assert.ok(livePhotoSource.includes("{#if canUseCamera}"));
});

test("the camera stream is stopped on capture, on cancel and on destroy", () => {
  assert.match(
    livePhotoSource,
    /onDestroy\(\(\) => \{\s*stopStream\(stream\);/,
  );
  assert.match(
    livePhotoSource,
    /function closeCamera\(\) \{\s*stopStream\(stream\);/,
  );
  // capture() closes before awaiting the upload, so nothing films the
  // applicant while a request is in flight.
  const capture = livePhotoSource.slice(
    livePhotoSource.indexOf("async function capture()"),
    livePhotoSource.indexOf("async function handleFile"),
  );
  assert.ok(
    capture.indexOf("closeCamera()") <
      capture.indexOf("uploadIdentityDocument"),
  );
});

test("camera failures are classified into copy we actually have", () => {
  const cases = {
    NotAllowedError: "denied",
    PermissionDeniedError: "denied",
    SecurityError: "denied",
    NotFoundError: "notFound",
    DevicesNotFoundError: "notFound",
    OverconstrainedError: "notFound",
    NotReadableError: "inUse",
    TrackStartError: "inUse",
    SomethingElse: "unknown",
  };

  for (const [name, expected] of Object.entries(cases)) {
    assert.equal(classifyCameraError({ name }), expected, name);
  }
  assert.equal(classifyCameraError(undefined), "unknown");
  assert.equal(classifyCameraError("a string"), "unknown");
});

test("every camera problem has an English string in the catalog", async () => {
  const english = JSON.parse(
    await readFile(
      new URL("../src/lib/locales/en.json", import.meta.url),
      "utf8",
    ),
  );
  const problems = english.dashboard.kyc.livePhoto.problems;

  for (const problem of [
    "unsupported",
    "denied",
    "notFound",
    "inUse",
    "insecureContext",
    "unknown",
  ]) {
    assert.equal(
      cameraProblemKey(problem),
      `dashboard.kyc.livePhoto.problems.${problem}`,
    );
    assert.equal(typeof problems[problem], "string");
    assert.ok(problems[problem].length > 0);
  }
});

test("stopStream survives anything the browser hands it", () => {
  assert.doesNotThrow(() => stopStream(null));
  assert.doesNotThrow(() => stopStream(undefined));
  assert.doesNotThrow(() => stopStream({}));

  const stopped = [];
  stopStream({
    getTracks: () => [
      { stop: () => stopped.push("a") },
      {
        stop: () => {
          throw new Error("already ended");
        },
      },
      { stop: () => stopped.push("c") },
    ],
  });
  // A track that throws must not prevent the others being stopped — that is
  // how a camera light gets left on.
  assert.deepEqual(stopped, ["a", "c"]);
});

test("the captured filename carries no user input and ends in .jpg", () => {
  const name = livePhotoFilename(new Date("2026-08-09T12:34:56.789Z"));
  assert.equal(name, "live-photo-2026-08-09T12-34-56-789Z.jpg");
  assert.doesNotMatch(name, /[^a-zA-Z0-9.-]/);
});

test("blobToLivePhotoFile is only reachable where File exists", () => {
  // Node 24 has File; the assertion documents that this helper is a browser
  // path and is not called during SSR.
  assert.equal(typeof blobToLivePhotoFile, "function");
  if (typeof File === "function" && typeof Blob === "function") {
    const file = blobToLivePhotoFile(new Blob(["x"]), "a.jpg");
    assert.equal(file.name, "a.jpg");
    assert.equal(file.type, "image/jpeg");
  }
});

// ---------------------------------------------------------------------------
// Upload pre-flight — a hint, never the security control
// ---------------------------------------------------------------------------

test("oversized files are rejected before the round trip", () => {
  const problem = preflightUpload(
    { name: "id.jpg", size: MAX_UPLOAD_BYTES + 1 },
    IDENTITY_PHOTO_EXTENSIONS,
  );
  assert.equal(problem.key, "dashboard.kyc.errors.fileTooLarge");
  assert.equal(problem.params.limit, "10MB");
  assert.ok(problem.fallback.includes("{limit}"));
});

test("the pre-flight is an allowlist, and it is extension-based", () => {
  assert.equal(
    preflightUpload({ name: "id.jpg", size: 10 }, IDENTITY_PHOTO_EXTENSIONS),
    null,
  );
  assert.equal(
    preflightUpload({ name: "ID.JPEG", size: 10 }, IDENTITY_PHOTO_EXTENSIONS),
    null,
  );
  assert.equal(
    preflightUpload({ name: "id.heic", size: 10 }, IDENTITY_PHOTO_EXTENSIONS),
    null,
  );

  // A PDF is fine for a tax form and wrong for an ID photo — the lists are
  // per-field on the server too.
  assert.equal(
    preflightUpload({ name: "w9.pdf", size: 10 }, TAX_FORM_EXTENSIONS),
    null,
  );
  assert.equal(
    preflightUpload({ name: "w9.pdf", size: 10 }, IDENTITY_PHOTO_EXTENSIONS)
      .key,
    "dashboard.kyc.errors.unsupportedFileType",
  );
  assert.equal(
    preflightUpload({ name: "evil.html", size: 10 }, IDENTITY_PHOTO_EXTENSIONS)
      .key,
    "dashboard.kyc.errors.unsupportedFileType",
  );
});

test("an extensionless file is passed to the server rather than guessed at", () => {
  // The server sniffs the bytes. Rejecting here would block real applicants
  // whose OS produced no extension.
  assert.equal(
    preflightUpload({ name: "scan", size: 10 }, IDENTITY_PHOTO_EXTENSIONS),
    null,
  );
});

test("the pre-flight never looks at the client-declared MIME type", () => {
  //`file.content_type` is attacker-chosen. A client-side check on it
  // would be theatre, and worse, would read as a control.
  const source = livePhotoSource + documentFieldSource + pageSource;
  assert.doesNotMatch(source, /file\.type\s*===/);
  assert.doesNotMatch(source, /ALLOWED_FILE_TYPES\.includes\(file\.type\)/);
});

test("both KYC error shapes are read, not just one", () => {
  assert.equal(readErrorDetail({ error: "bad file" }), "bad file");
  assert.equal(readErrorDetail({ message: "not editable" }), "not editable");
  assert.equal(readErrorDetail({ detail: "nope" }), "nope");
  assert.equal(readErrorDetail({ error: "  " }), "");
  assert.equal(readErrorDetail(null), "");
  assert.equal(readErrorDetail("plain string"), "");
});

// ---------------------------------------------------------------------------
// The page must never leak a KYC document into a cacheable or indexable page
// ---------------------------------------------------------------------------

test("the KYC route is covered by the layout's private-surface noindex rule", () => {
  const match = layoutSource.match(/privateSurface =\s*([\s\S]*?);\n/);
  assert.ok(match, "privateSurface assignment not found in +layout.svelte");

  const pattern = /\/(dashboard|private)(\/|$)/;
  assert.ok(
    match[1].includes(String(pattern)),
    "the privateSurface regex changed; re-check that /dashboard/kyc is still covered",
  );
  assert.ok(pattern.test("/ada/dashboard/kyc"));
});

test("the server load refuses to cache and sends an explicit robots header", () => {
  assert.match(pageServerSource, /"cache-control": "private, no-store"/);
  assert.match(pageServerSource, /"x-robots-tag": "noindex, nofollow/);
  assert.match(pageServerSource, /vary: "Cookie"/);
});

test("the server load returns document presence, never document URLs", () => {
  // A URL in the load's return value is serialized into the SSR HTML. The
  // presence booleans are all the stepper needs to resume.
  const returned = pageServerSource.slice(pageServerSource.indexOf("return {"));
  assert.doesNotMatch(returned, /id_front_url:/);
  assert.doesNotMatch(returned, /live_photo_url:/);
  assert.match(returned, /id_front: Boolean\(documents\?\.id_front_url\)/);
  assert.match(returned, /live_photo: Boolean\(documents\?\.live_photo_url\)/);
});

test("preview URLs are fetched by the browser, in onMount", () => {
  const onMountBlock = pageSource.slice(
    pageSource.indexOf("onMount(async () => {"),
    pageSource.indexOf("async function goToStep"),
  );
  assert.ok(onMountBlock.includes("fetchIdentityDocuments()"));
  assert.ok(onMountBlock.includes("fetchTaxFormFile()"));
});

test("the page carries its own noindex meta tag", () => {
  assert.match(
    pageSource,
    /<meta name="robots" content="noindex, nofollow, noarchive, noimageindex" \/>/,
  );
});

// ---------------------------------------------------------------------------
// 2Z are platform credits. A revenue share is money. Never the same sentence.
// ---------------------------------------------------------------------------

test("no user-facing KYC string implies 2Z are money", async () => {
  const catalogs = await Promise.all(
    ["en", "es", "fr", "pt-BR"].map(async (locale) =>
      JSON.parse(
        await readFile(
          new URL(`../src/lib/locales/${locale}.json`, import.meta.url),
          "utf8",
        ),
      ),
    ),
  );

  // Words that, applied to 2Z, assert a monetary character they do not have.
  // "revenue share" is deliberately absent: that genuinely is money.
  const banned = [
    /\bwithdraw\w*\b/i,
    /\bcash\s?out\b/i,
    /\bbalance\b/i,
    /\bfunds\b/i,
    /\bredeem\w*\b/i,
    /\bexchange rate\b/i,
    /\bwallet\b/i,
    /\bretirar\b/i,
    /\bsaldo\b/i,
    /\bmonedero\b/i,
    /\bretrait\b/i,
    /\bsolde\b/i,
    /\bportefeuille\b/i,
    /\bsacar\b/i,
    /\bcarteira\b/i,
  ];

  const findings = [];
  const walk = (node, path, locale) => {
    if (typeof node === "string") {
      for (const pattern of banned) {
        if (pattern.test(node)) findings.push(`${locale}.${path}: ${node}`);
      }
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        walk(value, path ? `${path}.${key}` : key, locale);
      }
    }
  };

  const locales = ["en", "es", "fr", "pt-BR"];
  catalogs.forEach((catalog, index) => {
    walk(catalog.dashboard.kyc, "dashboard.kyc", locales[index]);
  });

  assert.deepEqual(
    findings,
    [],
    "KYC copy must not describe 2Z as money. 2Z are platform credits; a " +
      "revenue share is money; the two must not be conflated.",
  );
});

test("the eligibility note removes credit gates and separates tax verification from agreement consent in every language", async () => {
  const expectations = {
    en: [
      /Usage credits are not required to apply/i,
      /Verification and tax signatures do not accept a compensation agreement/i,
      /agreement acceptance is recorded separately in Credits & Earnings/i,
    ],
    es: [
      /No se requieren créditos de uso para solicitar/i,
      /verificación y las firmas fiscales no aceptan un acuerdo de compensación/i,
      /aceptación del acuerdo se registra por separado en Créditos y ganancias/i,
    ],
    fr: [
      /Aucun crédit d’utilisation n’est nécessaire pour postuler/i,
      /vérification et les signatures fiscales n’acceptent pas un accord de rémunération/i,
      /acceptation de l’accord est enregistrée séparément dans Crédits et revenus/i,
    ],
    "pt-BR": [
      /Não é necessário ter créditos de uso para solicitar/i,
      /verificação e as assinaturas fiscais não aceitam um acordo de remuneração/i,
      /aceite do acordo é registrado separadamente em Créditos e ganhos/i,
    ],
  };

  for (const [locale, patterns] of Object.entries(expectations)) {
    const catalog = JSON.parse(
      await readFile(
        new URL(`../src/lib/locales/${locale}.json`, import.meta.url),
        "utf8",
      ),
    );
    for (const pattern of patterns)
      assert.match(catalog.dashboard.kyc.eligibilityNote, pattern, locale);
  }
});
