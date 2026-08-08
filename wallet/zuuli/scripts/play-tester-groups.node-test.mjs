import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  ANDROID_PUBLISHER_SCOPE,
  EXPECTED_SERVICE_ACCOUNT,
  PACKAGE_NAME,
  TOKEN_URL,
  TRACK,
  configurePlayTesterGroup,
  createServiceAccountAssertion,
  editUrl,
  mergeGoogleGroups,
  parseServiceAccountDocument,
  validateGoogleGroup,
} from "./play-tester-groups.mjs";

const GROUP = "zuuli-internal-testers-free2z@googlegroups.com";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function queuedFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    assert.ok(responses.length > 0, `unexpected request: ${options.method} ${url}`);
    const next = responses.shift();
    return typeof next === "function" ? next(url, options) : next;
  };
  return { calls, fetchImpl, remaining: responses };
}

function testCredentials() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    credentials: {
      type: "service_account",
      project_id: "corpora1",
      client_email: EXPECTED_SERVICE_ACCOUNT,
      private_key_id: "offline-test-key",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    },
    publicKey,
  };
}

test("validates only canonical lowercase Google Group addresses", () => {
  assert.equal(validateGoogleGroup(GROUP), GROUP);
  for (const invalid of [
    undefined,
    "",
    "Skylar@googlegroups.com",
    "skylar@gmail.com",
    "x@evil.googlegroups.com",
    `.bad@googlegroups.com`,
    `${"a".repeat(65)}@googlegroups.com`,
  ]) {
    assert.throws(() => validateGoogleGroup(invalid));
  }
});

test("unions tester groups additively and idempotently", () => {
  // Play also accepts Workspace-backed Google Groups on custom domains. The
  // requested group is intentionally strict, while existing groups are opaque
  // values that must be preserved.
  const old = "existing-testers@corpora.example";
  assert.deepEqual(mergeGoogleGroups([old], GROUP), [old, GROUP]);
  assert.deepEqual(mergeGoogleGroups([GROUP, old, GROUP], GROUP), [old, GROUP]);
  assert.deepEqual(mergeGoogleGroups(undefined, GROUP), [GROUP]);
  assert.throws(() => mergeGoogleGroups("not-an-array", GROUP));
});

test("builds a correctly scoped, one-hour RS256 service-account assertion", () => {
  const { credentials, publicKey } = testCredentials();
  const now = 1_786_196_000;
  const jwt = createServiceAccountAssertion(credentials, now);
  const [headerPart, claimsPart, signaturePart] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(headerPart, "base64url")), {
    alg: "RS256",
    typ: "JWT",
  });
  assert.deepEqual(JSON.parse(Buffer.from(claimsPart, "base64url")), {
    iss: EXPECTED_SERVICE_ACCOUNT,
    scope: ANDROID_PUBLISHER_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerPart}.${claimsPart}`);
  verifier.end();
  assert.equal(verifier.verify(publicKey, signaturePart, "base64url"), true);
  assert.throws(() =>
    createServiceAccountAssertion({ ...credentials, client_email: "other@example.com" }, now),
  );
  assert.throws(() =>
    createServiceAccountAssertion({ ...credentials, project_id: "other" }, now),
  );
});

test("redacts malformed service-account JSON parse failures", () => {
  assert.deepEqual(parseServiceAccountDocument('{"type":"service_account"}'), {
    type: "service_account",
  });
  assert.throws(
    () => parseServiceAccountDocument('{"private_key":"SECRET-FRAGMENT"'),
    (error) =>
      error.message === "service-account document is not valid JSON" &&
      !error.message.includes("SECRET-FRAGMENT"),
  );
});

test("constructs fixed package, edit, tester, and commit URLs", () => {
  assert.equal(
    editUrl(),
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/edits`,
  );
  assert.equal(
    editUrl("edit 1", `/testers/${TRACK}`),
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/edits/edit%201/testers/internal`,
  );
  assert.equal(editUrl("edit-1", ":commit").endsWith("/edits/edit-1:commit"), true);
});

test("preserves existing groups, commits, verifies through a fresh edit, and cleans up", async () => {
  const { credentials } = testCredentials();
  const old = "existing-testers@googlegroups.com";
  const mock = queuedFetch([
    jsonResponse({ access_token: "in-memory-token" }),
    jsonResponse({ id: "write-edit" }),
    jsonResponse({ googleGroups: [old] }),
    jsonResponse({ googleGroups: [old, GROUP] }),
    jsonResponse({ id: "write-edit", expiryTimeSeconds: "1" }),
    jsonResponse({ id: "verify-edit" }),
    jsonResponse({ googleGroups: [GROUP, old] }),
    new Response(null, { status: 204 }),
  ]);

  const result = await configurePlayTesterGroup({
    credentials,
    googleGroup: GROUP,
    fetchImpl: mock.fetchImpl,
    nowSeconds: 1_786_196_000,
  });

  assert.deepEqual(result, {
    packageName: PACKAGE_NAME,
    track: TRACK,
    googleGroups: [old, GROUP],
  });
  assert.equal(mock.remaining.length, 0);
  assert.equal(mock.calls[0].url, TOKEN_URL);
  assert.equal(mock.calls[0].options.method, "POST");
  assert.equal(
    mock.calls[0].options.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  assert.equal(
    mock.calls[0].options.body.get("grant_type"),
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  );
  assert.equal(mock.calls[0].options.body.get("assertion").split(".").length, 3);
  assert.deepEqual(
    mock.calls.slice(1).map(({ url, options }) => [options.method, new URL(url).pathname]),
    [
      ["POST", `/androidpublisher/v3/applications/${PACKAGE_NAME}/edits`],
      ["GET", `/androidpublisher/v3/applications/${PACKAGE_NAME}/edits/write-edit/testers/${TRACK}`],
      ["PUT", `/androidpublisher/v3/applications/${PACKAGE_NAME}/edits/write-edit/testers/${TRACK}`],
      ["POST", `/androidpublisher/v3/applications/${PACKAGE_NAME}/edits/write-edit:commit`],
      ["POST", `/androidpublisher/v3/applications/${PACKAGE_NAME}/edits`],
      ["GET", `/androidpublisher/v3/applications/${PACKAGE_NAME}/edits/verify-edit/testers/${TRACK}`],
      ["DELETE", `/androidpublisher/v3/applications/${PACKAGE_NAME}/edits/verify-edit`],
    ],
  );
  assert.deepEqual(JSON.parse(mock.calls[3].options.body), {
    googleGroups: [old, GROUP],
  });
  assert.equal(mock.calls[4].options.body, undefined);
  for (const call of mock.calls.slice(1)) {
    assert.equal(call.options.headers.authorization, "Bearer in-memory-token");
  }
});

test("rejects a lossy update response and deletes the write edit", async () => {
  const { credentials } = testCredentials();
  const old = "existing-testers@googlegroups.com";
  const mock = queuedFetch([
    jsonResponse({ access_token: "token" }),
    jsonResponse({ id: "lossy-edit" }),
    jsonResponse({ googleGroups: [old] }),
    jsonResponse({ googleGroups: [GROUP] }),
    new Response(null, { status: 204 }),
  ]);
  await assert.rejects(
    configurePlayTesterGroup({
      credentials,
      googleGroup: GROUP,
      fetchImpl: mock.fetchImpl,
      nowSeconds: 1_786_196_000,
    }),
    /did not preserve the requested group set/,
  );
  assert.equal(mock.calls.at(-1).options.method, "DELETE");
  assert.equal(mock.calls.at(-1).url, editUrl("lossy-edit"));
});

test("rejects committed-state drift and deletes the verification edit", async () => {
  const { credentials } = testCredentials();
  const old = "existing-testers@googlegroups.com";
  const mock = queuedFetch([
    jsonResponse({ access_token: "token" }),
    jsonResponse({ id: "write-edit" }),
    jsonResponse({ googleGroups: [old] }),
    jsonResponse({ googleGroups: [old, GROUP] }),
    jsonResponse({ id: "write-edit" }),
    jsonResponse({ id: "verify-edit" }),
    jsonResponse({ googleGroups: [GROUP] }),
    new Response(null, { status: 204 }),
  ]);
  await assert.rejects(
    configurePlayTesterGroup({
      credentials,
      googleGroup: GROUP,
      fetchImpl: mock.fetchImpl,
      nowSeconds: 1_786_196_000,
    }),
    /exact committed tester group set/,
  );
  assert.equal(mock.calls.at(-1).options.method, "DELETE");
  assert.equal(mock.calls.at(-1).url, editUrl("verify-edit"));
});

test("reports API failures and deletes the uncommitted edit", async () => {
  const { credentials } = testCredentials();
  const mock = queuedFetch([
    jsonResponse({ access_token: "token" }),
    jsonResponse({ id: "failed-edit" }),
    jsonResponse({ error: { message: "synthetic Play failure" } }, 500),
    new Response(null, { status: 204 }),
  ]);

  await assert.rejects(
    configurePlayTesterGroup({
      credentials,
      googleGroup: GROUP,
      fetchImpl: mock.fetchImpl,
      nowSeconds: 1_786_196_000,
    }),
    /HTTP 500: synthetic Play failure/,
  );
  assert.equal(mock.remaining.length, 0);
  assert.equal(mock.calls.at(-1).options.method, "DELETE");
  assert.equal(mock.calls.at(-1).url, editUrl("failed-edit"));
});
