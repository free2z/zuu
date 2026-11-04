/**
 * The server's reason reaches the person.
 *
 * Every non-2xx through the generated client used to become
 * `ApiError("HTTP error! status: 400")`; call sites that toast `error.message`
 * (donate among them) showed that while the body said exactly what was
 * wrong. These pin the parser against the shapes THIS API returns, and that
 * the mutator puts the result in `message`.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

import {
  genericHttpErrorMessage,
  readApiError,
  serverErrorMessage,
  serverFieldErrors,
} from "../src/lib/api/api-errors.js";

test("request-level reasons, in priority order", () => {
  assert.equal(
    serverErrorMessage({
      detail: "Authentication credentials were not provided.",
    }),
    "Authentication credentials were not provided.",
  );
  // tuzis/ztripe views answer `{"error":...}`.
  assert.equal(
    serverErrorMessage({ error: "Insufficient 2Z balance." }),
    "Insufficient 2Z balance.",
  );
  assert.equal(serverErrorMessage({ message: "Try later." }), "Try later.");
  assert.equal(
    serverErrorMessage({ non_field_errors: ["Passwords must differ."] }),
    "Passwords must differ.",
  );
  // `detail` wins over a field error in the same body.
  assert.equal(
    serverErrorMessage({ detail: "Throttled.", amount: ["Too big."] }),
    "Throttled.",
  );
});

test("change-password's field errors become the message", () => {
  // py/free2z/dj/apps/emails/views.py
  assert.equal(
    serverErrorMessage({ old_password: ["Incorrect password."] }),
    "Incorrect password.",
  );
  assert.equal(
    serverErrorMessage({
      new_password: [
        "This password is too short. It must contain at least 8 characters.",
        "This password is too common.",
      ],
    }),
    "This password is too short. It must contain at least 8 characters.",
  );
  assert.deepEqual(serverFieldErrors({ otp_token: ["Invalid code."] }), {
    otp_token: "Invalid code.",
  });
});

test("a field message that does not name its field gets the field's name", () => {
  assert.equal(
    serverErrorMessage({ new_password: ["This field is required."] }),
    "New password: This field is required.",
  );
});

test("a bare JSON string body is a reason (zPage create's 1 2Z refusal)", () => {
  assert.equal(
    serverErrorMessage("You need at least 1 2Z to create another page."),
    "You need at least 1 2Z to create another page.",
  );
});

test("nothing usable yields '', never an invented reason", () => {
  for (const body of [
    null,
    undefined,
    {},
    [],
    { detail: "" },
    { title: [] },
    42,
    "<!DOCTYPE html><html><body>502 Bad Gateway</body></html>",
    { detail: "x".repeat(500) },
  ]) {
    assert.equal(serverErrorMessage(body), "", JSON.stringify(body));
  }
});

test("the generic fallback is a sentence that keeps the status", () => {
  const message = genericHttpErrorMessage(502);
  assert.match(message, /502/);
  assert.doesNotMatch(message, /HTTP error!/);
});

test("readApiError reads a Response once and never throws", async () => {
  const failure = await readApiError(
    new Response(JSON.stringify({ old_password: ["Incorrect password."] }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }),
  );
  assert.equal(failure.status, 400);
  assert.equal(failure.message, "Incorrect password.");
  assert.deepEqual(failure.fieldErrors, {
    old_password: "Incorrect password.",
  });

  const html = await readApiError(
    new Response("<html>504 Gateway Time-out</html>", { status: 504 }),
  );
  assert.equal(html.status, 504);
  assert.equal(html.message, "");
  assert.equal(html.data, null);

  const empty = await readApiError(new Response(null, { status: 403 }));
  assert.equal(empty.message, "");
});

// ---------------------------------------------------------------------------
// The mutator: `ApiError.message` IS the server's reason now.
// ---------------------------------------------------------------------------

let server;
let customInstance;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ customInstance } = await server.ssrLoadModule("/src/lib/api/mutator.ts"));
});

after(async () => {
  await server?.close();
});

async function rejectionFor(status, body) {
  const nativeFetch = globalThis.fetch;
  const nativeConsoleError = console.error;
  console.error = () => undefined;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  try {
    await customInstance({
      url: "/api/tuzis/donate-idempotent/bob",
      method: "POST",
    });
  } catch (error) {
    return error;
  } finally {
    globalThis.fetch = nativeFetch;
    console.error = nativeConsoleError;
  }
  throw new Error("expected a rejection");
}

test("mutator: ApiError.message is the server's sentence", async () => {
  const error = await rejectionFor(400, { error: "Insufficient 2Z balance." });
  assert.equal(error.name, "ApiError");
  assert.equal(error.status, 400);
  assert.equal(error.message, "Insufficient 2Z balance.");
  assert.equal(error.serverMessage, "Insufficient 2Z balance.");
  // `.data` is untouched for callers that read specific fields.
  assert.deepEqual(error.data, { error: "Insufficient 2Z balance." });
  assert.doesNotMatch(error.message, /HTTP error!/);
});

test("mutator: field errors are exposed and the first is the message", async () => {
  const error = await rejectionFor(400, {
    amount: ["Ensure this value is greater than or equal to 1."],
  });
  assert.equal(
    error.message,
    "Amount: Ensure this value is greater than or equal to 1.",
  );
  assert.deepEqual(error.fieldErrors, {
    amount: "Ensure this value is greater than or equal to 1.",
  });
});

test("mutator: no reason in the body -> a sentence with the status", async () => {
  const error = await rejectionFor(502, "<html>Bad Gateway</html>");
  assert.equal(error.status, 502);
  assert.equal(error.serverMessage, "");
  assert.equal(error.message, genericHttpErrorMessage(502));
});
