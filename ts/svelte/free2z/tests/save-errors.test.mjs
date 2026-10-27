import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  SERVER_MESSAGE_MAX_LENGTH,
  apiFieldErrors,
  apiRequestErrorMessage,
  describeSaveFailure,
  flattenApiErrorMessage,
  isScheduleInThePast,
  saveNoticeReason,
} from "../src/lib/save-errors.js";

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const GENERIC = "Failed to save article";
const SUMMARY = "Please fix the validation errors.";
const PUBLISH_AT_COPY =
  "Your scheduled publish time has passed. Open the publish menu to publish now, or pick a new time.";

/** The editor's call shape, with only the parts a case cares about set. */
function describe(result, curated = {}, extra = {}, status = 400) {
  return describeSaveFailure({
    result,
    status,
    curated,
    extra,
    genericMessage: GENERIC,
    summaryMessage: SUMMARY,
  });
}

test("flattens the shapes DRF actually returns", () => {
  assert.equal(
    flattenApiErrorMessage(["Choose a future time."]),
    "Choose a future time.",
  );
  assert.equal(flattenApiErrorMessage("Not found."), "Not found.");
  assert.equal(
    flattenApiErrorMessage({ featured_image: ["Invalid pk."] }),
    "Invalid pk.",
  );
  // Not messages — the old `result.field` truthiness check reported these as
  // errors the creator could never locate.
  assert.equal(flattenApiErrorMessage([]), "");
  assert.equal(flattenApiErrorMessage({}), "");
  assert.equal(flattenApiErrorMessage(null), "");
  assert.equal(flattenApiErrorMessage(0), "");
});

test("field errors keep serializer order and skip request-level keys", () => {
  assert.deepEqual(
    apiFieldErrors({
      non_field_errors: ["Bad request."],
      title: ["This field may not be blank."],
      publish_at: ["Choose a future time to schedule this page."],
      detail: "Ignored.",
    }),
    [
      { field: "title", message: "This field may not be blank." },
      {
        field: "publish_at",
        message: "Choose a future time to schedule this page.",
      },
    ],
  );

  assert.deepEqual(apiFieldErrors(null), []);
  assert.deepEqual(apiFieldErrors("boom"), []);
  assert.deepEqual(apiFieldErrors(["boom"]), []);
});

test("request-level messages are read from detail and non_field_errors", () => {
  assert.equal(
    apiRequestErrorMessage({
      detail: "Authentication credentials were not provided.",
    }),
    "Authentication credentials were not provided.",
  );
  assert.equal(
    apiRequestErrorMessage({ non_field_errors: ["Nope."] }),
    "Nope.",
  );
  assert.equal(apiRequestErrorMessage({ title: ["Nope."] }), "");
});

// The bug in: a past-due schedule made every autosave fail with the
// catch-all, so the creator was never told which field was refused.
test("a past-due publish_at reaches the creator instead of the generic error", () => {
  const failure = describe(
    { publish_at: ["Choose a future time to schedule this page."] },
    { publish_at: PUBLISH_AT_COPY },
  );

  assert.equal(failure.fieldErrors.publish_at, PUBLISH_AT_COPY);
  assert.equal(failure.saveError, PUBLISH_AT_COPY);
  assert.notEqual(failure.saveError, GENERIC);
  assert.equal(failure.isValidationFailure, true);
});

// The general half of the fix: the handler no longer enumerates which fields
// it is willing to show, so a field nobody wrote copy for still surfaces.
test("a field with no product copy surfaces the server's own sentence", () => {
  const failure = describe({ p2paddr: ["Enter a valid Zcash address."] });

  assert.equal(failure.fieldErrors.p2paddr, "Enter a valid Zcash address.");
  assert.equal(failure.saveError, "Enter a valid Zcash address.");
  assert.equal(failure.isValidationFailure, true);
});

test("product copy wins over the server sentence for the fields that have it", () => {
  const failure = describe(
    { vanity: ["zpage with this vanity already exists."] },
    { vanity: "Choose a different vanity URL." },
  );

  assert.equal(failure.fieldErrors.vanity, "Choose a different vanity URL.");
  assert.equal(failure.saveError, "Choose a different vanity URL.");
});

test("several rejected fields each get a message and the notice summarizes", () => {
  const failure = describe(
    {
      title: ["This field may not be blank."],
      publish_at: ["Choose a future time to schedule this page."],
    },
    {
      title: "Enter a valid article title.",
      publish_at: PUBLISH_AT_COPY,
    },
  );

  assert.deepEqual(failure.fieldErrors, {
    title: "Enter a valid article title.",
    publish_at: PUBLISH_AT_COPY,
  });
  // Both reasons, spelled out. `publish_at`'s inline slot is inside a publish
  // sheet the creator has closed, so "some component renders it" would not
  // have meant they could see it.
  assert.equal(
    failure.saveError,
    `Enter a valid article title. ${PUBLISH_AT_COPY}`,
  );
  assert.equal(failure.isValidationFailure, true);
});

// The canonical-URL autosave fallback retries without the field, so the body
// being read cannot name what failed.
test("client-detected field errors merge with the body's", () => {
  const failure = describe(
    { title: ["This field may not be blank."] },
    { title: "Enter a valid article title." },
    {
      canonical_url: "Enter the full original article URL, including https://.",
    },
  );

  assert.equal(
    failure.fieldErrors.canonical_url,
    "Enter the full original article URL, including https://.",
  );
  assert.equal(
    failure.saveError,
    "Enter a valid article title. " +
      "Enter the full original article URL, including https://.",
  );
});

test("a body-level rejection of a field is not overwritten by the client's", () => {
  const failure = describe(
    { canonical_url: ["Enter a valid URL."] },
    { canonical_url: "Product copy." },
    { canonical_url: "Client copy." },
  );

  assert.equal(failure.fieldErrors.canonical_url, "Product copy.");
});

// A 400 that explains itself is a refusal to act on, never a transport
// failure — it must not end up behind "The server could not be reached."
test("a request-level 400 message reaches the creator and counts as a refusal", () => {
  const failure = describe({ non_field_errors: ["Pick at least one tag."] });

  assert.deepEqual(failure.fieldErrors, {});
  assert.equal(failure.saveError, "Pick at least one tag.");
  assert.equal(failure.isValidationFailure, true);
});

// Until  `POST /api/zpage/` answered the 2Z gate with a bare-string 400,
// and a backend from before that release still can — a bare JSON string, not
// a field map. (It is a `402 insufficient_funds` now.)
test("a bare-string 400 body is a message, not a malformed response", () => {
  const tuziGate =
    "You need at least 1 tuzi to create another page. Get your profile " +
    "going and work on your first zPage and someone will give you a tuzi.";
  const failure = describe(tuziGate);

  assert.equal(failure.saveError, tuziGate);
  assert.equal(failure.isValidationFailure, true);
  assert.equal(apiRequestErrorMessage(tuziGate), tuziGate);
});

// Fixing the field and hitting the unmentioned resource-level wall again is
// the same "why did my save stop working" the issue is about.
test("a request-level reason survives alongside the field ones", () => {
  const failure = describe({
    non_field_errors: ["This article is locked for review."],
    vanity: ["zpage with this vanity already exists."],
  });

  assert.equal(
    failure.saveError,
    "This article is locked for review. zpage with this vanity already exists.",
  );
});

// A refusal stays a refusal even when its wording is unusable — reporting one
// as "The server could not be reached." sends the creator to retry a save that
// will be refused identically forever.
test("a 400 whose wording is unusable is still a refusal, not an outage", () => {
  const wall = "x".repeat(SERVER_MESSAGE_MAX_LENGTH + 1);

  const overLongDetail = describe({ detail: wall });
  assert.equal(overLongDetail.saveError, SUMMARY);
  assert.equal(overLongDetail.isValidationFailure, true);

  const empty = describe({});
  assert.deepEqual(empty.fieldErrors, {});
  assert.equal(empty.saveError, GENERIC);
  assert.equal(empty.isValidationFailure, true);
});

test("an unrenderable server string falls back rather than dumping into a toast", () => {
  const wall = "x".repeat(SERVER_MESSAGE_MAX_LENGTH + 1);
  const failure = describe({ tags: [wall] });

  assert.deepEqual(failure.fieldErrors, {});
  assert.equal(failure.saveError, SUMMARY);
  // Still a validation failure: retrying the same payload cannot help.
  assert.equal(failure.isValidationFailure, true);
});

// Neither field has any inline slot at all, so a summary would name nothing.
test("rejected fields with nowhere to render are spelled out", () => {
  const failure = describe({
    content: ["Ensure this field has no more than 100000 characters."],
    p2paddr: ["Enter a valid Zcash address."],
  });

  assert.equal(
    failure.saveError,
    "Ensure this field has no more than 100000 characters. " +
      "Enter a valid Zcash address.",
  );
  assert.equal(failure.isValidationFailure, true);
});

// The translation routes refuse a stale editor with a field-shaped 409, and
// nothing retries a 409 — see `_stale_translation_editor_response`.
test("a field-shaped 409 is a refusal with a remedy, not an unreachable server", () => {
  const remedy =
    "Reload the editor before saving a translation for this legacy article.";
  const failure = describe({ source_language: remedy }, {}, {}, 409);

  assert.equal(failure.fieldErrors.source_language, remedy);
  assert.equal(failure.saveError, remedy);
  assert.equal(failure.isValidationFailure, true);
});

// Only DRF's ValidationError is a 400. An ingress, a service worker or an
// unhandled exception can return any JSON, and its keys are not form fields.
test("a non-400 body is an outage, not a rejected field", () => {
  const failure = describe({ error: "upstream unavailable" }, {}, {}, 503);

  assert.deepEqual(failure.fieldErrors, {});
  assert.equal(failure.saveError, GENERIC);
  assert.equal(failure.isValidationFailure, false);
});

test("a non-400 with a detail still says what the server said", () => {
  const failure = describe(
    { detail: "Request was throttled. Expected available in 60 seconds." },
    {},
    {},
    429,
  );

  assert.equal(
    failure.saveError,
    "Request was throttled. Expected available in 60 seconds.",
  );
  assert.equal(failure.isValidationFailure, false);
});

test("a 500 whose body happens to name a field is not a validation failure", () => {
  const failure = describe(
    { title: "database is down" },
    { title: "Enter a valid article title." },
    {},
    500,
  );

  assert.deepEqual(failure.fieldErrors, {});
  assert.equal(failure.isValidationFailure, false);
});

// Mapping the message is only half the fix: it has to land somewhere the
// creator sees. An autosave shows no toast, the topbar chip shows a label, and
// the per-field text is inside a publish sheet that is closed.
test("the persistent notice carries the reason, not the generic validation copy", () => {
  assert.equal(
    saveNoticeReason(
      "validation",
      PUBLISH_AT_COPY,
      "Some fields still need fixing.",
    ),
    PUBLISH_AT_COPY,
  );
  // Other blocked-save reasons already describe themselves better.
  assert.equal(
    saveNoticeReason(
      "request-failed",
      GENERIC,
      "The server could not be reached.",
    ),
    "The server could not be reached.",
  );
  assert.equal(
    saveNoticeReason("validation", null, "Some fields still need fixing."),
    "Some fields still need fixing.",
  );
  assert.equal(saveNoticeReason(null, PUBLISH_AT_COPY, null), null);
});

test("only the payload the backend refuses is labelled past-due", () => {
  const now = Date.parse("2026-08-16T12:00:00Z");

  assert.equal(
    isScheduleInThePast(
      { is_published: false, publish_at: "2026-08-16T11:00:00Z" },
      now,
    ),
    true,
  );
  assert.equal(
    isScheduleInThePast(
      { is_published: false, publish_at: "2026-08-16T13:00:00Z" },
      now,
    ),
    false,
  );
  // Publishing clears the schedule server-side, so this is never the reason.
  assert.equal(
    isScheduleInThePast(
      { is_published: true, publish_at: "2026-08-16T11:00:00Z" },
      now,
    ),
    false,
  );
  assert.equal(
    isScheduleInThePast({ is_published: false, publish_at: null }, now),
    false,
  );
  // A malformed datetime is rejected for a different reason; do not claim it
  // is past due.
  assert.equal(
    isScheduleInThePast({ is_published: false, publish_at: "not a date" }, now),
    false,
  );
});

test("a publish_at rejection that is not past-due keeps the server's reason", () => {
  const failure = describe(
    { publish_at: ["Datetime has wrong format."] },
    {
      publish_at: isScheduleInThePast({
        is_published: false,
        publish_at: "not a date",
      })
        ? PUBLISH_AT_COPY
        : undefined,
    },
  );

  assert.equal(failure.fieldErrors.publish_at, "Datetime has wrong format.");
});

test("the editor asks for a publish_at message the catalogs actually define", () => {
  const editor = fs.readFileSync(
    path.join(APP_ROOT, "src/routes/edit/+page.svelte"),
    "utf8",
  );
  assert.match(editor, /editor\.publishAtPastDue/);

  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const catalog = JSON.parse(
      fs.readFileSync(
        path.join(APP_ROOT, `src/lib/locales/${locale}.json`),
        "utf8",
      ),
    );
    assert.equal(
      typeof catalog.editor?.publishAtPastDue,
      "string",
      `${locale}.json is missing editor.publishAtPastDue`,
    );
  }
});

test("the publish sheet renders the publish_at error next to the schedule input", () => {
  const sheet = fs.readFileSync(
    path.join(APP_ROOT, "src/lib/components/mdEditor/PublishSheet.svelte"),
    "utf8",
  );

  assert.match(sheet, /validationErrors\.publish_at/);
  assert.match(
    sheet,
    /aria-invalid=\{Boolean\(validationErrors\.publish_at\)\}/,
  );
});

// The regression that made the mapping pointless: both surfaces a failed
// autosave reaches rendered the generic key instead of the message.
test("the always-visible surfaces render the reason, not the generic key", () => {
  const topbar = fs.readFileSync(
    path.join(APP_ROOT, "src/lib/components/mdEditor/EditorTopbar.svelte"),
    "utf8",
  );
  const tooltip = topbar.slice(topbar.indexOf("<Tooltip.Content>"));
  assert.match(
    tooltip,
    /\{#if saveError\}\s*(<!--[\s\S]*?-->\s*)?<p>\{saveError\}<\/p>/,
  );

  const editor = fs.readFileSync(
    path.join(APP_ROOT, "src/routes/edit/+page.svelte"),
    "utf8",
  );
  assert.match(editor, /saveNoticeReason\(\s*saveBlockReason,\s*saveError,/);
});
