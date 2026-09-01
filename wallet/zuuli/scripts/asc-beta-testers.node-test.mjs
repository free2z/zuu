import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { ASC_API_ROOT, ASC_APP_ID, ASC_BUNDLE_ID, ASC_INTERNAL_GROUP, AscStateError } from "./asc-testflight.mjs";
import {
  createBetaTesterApiClient,
  inviteBetaTester,
  normalizeBetaTesterEmail,
  parseCliArgs,
  selectBetaTester,
} from "./asc-beta-testers.mjs";

const KEY_ID = "AB12CD34EF";
const ISSUER_ID = "12345678-1234-1234-1234-123456789abc";
const EMAIL = "devferri22@gmail.com";

function keyPair() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" });
}

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

function group(overrides = {}) {
  return {
    id: "group-internal",
    name: ASC_INTERNAL_GROUP,
    isInternalGroup: true,
    hasAccessToAllBuilds: false,
    ...overrides,
  };
}

function tester(overrides = {}) {
  return {
    id: "tester-1",
    email: EMAIL,
    betaGroupIds: [],
    ...overrides,
  };
}

function fakeTesterApi({
  groups = [group()],
  testers = [],
  createError,
  createLands = true,
  createGroupIds = ["group-internal"],
  addError,
  addLands = true,
} = {}) {
  const calls = [];
  let testerResources = testers.map((item) => ({ ...item, betaGroupIds: [...item.betaGroupIds] }));
  let nextTesterId = testerResources.length + 1;
  return {
    calls,
    api: {
      async listBetaGroups() {
        calls.push(["listBetaGroups"]);
        return [...groups];
      },
      async listBetaTestersByEmail(email) {
        calls.push(["listBetaTestersByEmail", email]);
        return testerResources
          .filter((item) => item.email === email)
          .map((item) => ({ ...item, betaGroupIds: [...item.betaGroupIds] }));
      },
      async createBetaTester({ email, firstName, lastName, groupId }) {
        calls.push(["createBetaTester", { email, firstName, lastName, groupId }]);
        if (createLands) {
          const created = {
            id: `tester-${nextTesterId++}`,
            email,
            betaGroupIds: [...createGroupIds],
          };
          testerResources.push(created);
        }
        if (createError) throw createError;
        return { id: `tester-${nextTesterId}`, email };
      },
      async addTesterToGroup(groupId, testerId) {
        calls.push(["addTesterToGroup", groupId, testerId]);
        if (addLands) {
          const existing = testerResources.find((item) => item.id === testerId);
          if (existing && !existing.betaGroupIds.includes(groupId)) {
            existing.betaGroupIds.push(groupId);
          }
        }
        if (addError) throw addError;
      },
    },
  };
}

test("constructs beta tester lookup, creation, and group-add requests with a correctly formed relationship", async () => {
  const privateKey = keyPair();
  const mock = queuedFetch([
    jsonResponse({ data: [] }),
    jsonResponse(
      {
        data: {
          type: "betaTesters",
          id: "tester-1",
          attributes: { email: EMAIL, firstName: "Dev", lastName: "Ferri" },
        },
      },
      201,
    ),
    new Response(null, { status: 204 }),
  ]);
  const api = createBetaTesterApiClient({
    keyId: KEY_ID,
    issuerId: ISSUER_ID,
    privateKey,
    fetchImpl: mock.fetchImpl,
    nowSeconds: () => 1_786_196_000,
  });

  const found = await api.listBetaTestersByEmail(EMAIL);
  assert.deepEqual(found, []);
  const created = await api.createBetaTester({
    email: EMAIL,
    firstName: "Dev",
    lastName: "Ferri",
    groupId: "group-internal",
  });
  assert.deepEqual(created, { id: "tester-1", email: EMAIL });
  await api.addTesterToGroup("group-internal", "tester-1");

  const lookupUrl = new URL(mock.calls[0].url);
  assert.equal(lookupUrl.origin, ASC_API_ROOT);
  assert.equal(lookupUrl.pathname, "/v1/betaTesters");
  assert.equal(lookupUrl.searchParams.get("filter[email]"), EMAIL);

  assert.equal(mock.calls[1].options.method, "POST");
  assert.deepEqual(JSON.parse(mock.calls[1].options.body), {
    data: {
      type: "betaTesters",
      attributes: { email: EMAIL, firstName: "Dev", lastName: "Ferri" },
      relationships: {
        betaGroups: { data: [{ type: "betaGroups", id: "group-internal" }] },
      },
    },
  });

  assert.equal(mock.calls[2].options.method, "POST");
  const addUrl = new URL(mock.calls[2].url);
  assert.equal(addUrl.pathname, "/v1/betaGroups/group-internal/relationships/betaTesters");
  assert.deepEqual(JSON.parse(mock.calls[2].options.body), {
    data: [{ type: "betaTesters", id: "tester-1" }],
  });
  assert.equal(mock.remaining.length, 0);
  for (const call of mock.calls) {
    const url = new URL(call.url);
    assert.equal(url.origin, ASC_API_ROOT);
    assert.equal(url.pathname.startsWith("/v1/"), true);
    assert.match(call.options.headers.authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  }
});

test("rejects malformed beta tester lookup and creation responses", async () => {
  const privateKey = keyPair();
  const malformedLookup = queuedFetch([jsonResponse({ data: [{ type: "betaTesters", id: "t1" }] })]);
  const lookupApi = createBetaTesterApiClient({
    keyId: KEY_ID,
    issuerId: ISSUER_ID,
    privateKey,
    fetchImpl: malformedLookup.fetchImpl,
    nowSeconds: () => 1,
  });
  await assert.rejects(
    lookupApi.listBetaTestersByEmail(EMAIL),
    (error) => error.code === "ASC_INVALID_RESPONSE",
  );

  const malformedCreate = queuedFetch([
    jsonResponse({ data: { type: "apps", id: "x", attributes: {} } }, 201),
  ]);
  const createApi = createBetaTesterApiClient({
    keyId: KEY_ID,
    issuerId: ISSUER_ID,
    privateKey,
    fetchImpl: malformedCreate.fetchImpl,
    nowSeconds: () => 1,
  });
  await assert.rejects(
    createApi.createBetaTester({ email: EMAIL, groupId: "group-internal" }),
    (error) => error.code === "ASC_INVALID_RESPONSE",
  );

  const malformedList = queuedFetch([jsonResponse({ data: "not-an-array" })]);
  const listApi = createBetaTesterApiClient({
    keyId: KEY_ID,
    issuerId: ISSUER_ID,
    privateKey,
    fetchImpl: malformedList.fetchImpl,
    nowSeconds: () => 1,
  });
  await assert.rejects(
    listApi.listBetaTestersByEmail(EMAIL),
    (error) => error.code === "ASC_INVALID_RESPONSE",
  );
});

test("sanitizes App Store Connect errors for beta tester requests", async () => {
  const privateKey = keyPair();
  const secret = "tester@example.invalid secret-token";
  const mock = queuedFetch([
    jsonResponse(
      { errors: [{ status: "403", code: "FORBIDDEN_ERROR", title: "The request is forbidden", detail: secret }] },
      403,
    ),
  ]);
  const api = createBetaTesterApiClient({
    keyId: KEY_ID,
    issuerId: ISSUER_ID,
    privateKey,
    fetchImpl: mock.fetchImpl,
    nowSeconds: () => 1,
  });
  await assert.rejects(
    api.listBetaTestersByEmail(EMAIL),
    (error) =>
      error.code === "ASC_API_ERROR" &&
      error.message.includes("FORBIDDEN_ERROR") &&
      !error.message.includes(secret),
  );
});

test("selects only the exact beta tester email and rejects duplicates", () => {
  assert.equal(selectBetaTester([tester()], EMAIL).id, "tester-1");
  assert.equal(selectBetaTester([tester({ email: "other@example.com" })], EMAIL), undefined);
  assert.throws(
    () => selectBetaTester([tester(), tester({ id: "duplicate" })], EMAIL),
    (error) => error.code === "AMBIGUOUS_BETA_TESTER",
  );
});

test("invites a brand-new beta tester into the internal group", async () => {
  const fixture = fakeTesterApi({ testers: [] });
  const evidence = await inviteBetaTester({
    api: fixture.api,
    email: EMAIL,
    firstName: "Dev",
    lastName: "Ferri",
    nowMs: () => 1_786_196_000_000,
  });
  assert.equal(evidence.mode, "invite");
  assert.equal(evidence.tester.outcome, "invited");
  assert.equal(evidence.tester.conflictRecovered, false);
  assert.equal(evidence.group.id, "group-internal");
  assert.equal(evidence.group.name, ASC_INTERNAL_GROUP);
  assert.equal(evidence.application.bundleId, ASC_BUNDLE_ID);
  assert.equal(
    fixture.calls.filter(([operation]) => operation === "createBetaTester").length,
    1,
  );
  assert.equal(JSON.stringify(evidence).includes(EMAIL), false);
  assert.equal(typeof evidence.tester.emailDigest, "string");
  assert.ok(evidence.tester.emailDigest.length > 0);
});

test("is idempotent when the tester is already a member of the internal group", async () => {
  const fixture = fakeTesterApi({ testers: [tester({ betaGroupIds: ["group-internal"] })] });
  const evidence = await inviteBetaTester({ api: fixture.api, email: EMAIL, nowMs: () => 1 });
  assert.equal(evidence.tester.outcome, "already_in_group");
  assert.equal(evidence.tester.conflictRecovered, false);
  assert.equal(fixture.calls.some(([operation]) => operation === "createBetaTester"), false);
  assert.equal(fixture.calls.some(([operation]) => operation === "addTesterToGroup"), false);
});

test("adds an existing beta tester who is not yet in the internal group", async () => {
  const fixture = fakeTesterApi({ testers: [tester({ betaGroupIds: ["other-group"] })] });
  const evidence = await inviteBetaTester({ api: fixture.api, email: EMAIL, nowMs: () => 1 });
  assert.equal(evidence.tester.outcome, "invited");
  assert.equal(
    fixture.calls.filter(([operation]) => operation === "addTesterToGroup").length,
    1,
  );
  assert.equal(fixture.calls.some(([operation]) => operation === "createBetaTester"), false);
});

test("treats a duplicate-tester conflict as success once readback proves group membership", async () => {
  const fixture = fakeTesterApi({
    testers: [],
    createError: new AscStateError(
      "ASC_API_ERROR",
      "not_observed",
      "CONFLICT: a beta tester with this email already exists",
      { retryable: false },
    ),
    createLands: true,
    createGroupIds: ["group-internal"],
  });
  const evidence = await inviteBetaTester({ api: fixture.api, email: EMAIL, nowMs: () => 1 });
  assert.equal(evidence.tester.outcome, "already_in_group");
  assert.equal(evidence.tester.conflictRecovered, true);
  assert.equal(
    fixture.calls.filter(([operation]) => operation === "createBetaTester").length,
    1,
  );
});

test("rejects an invite whose mutation error is not vindicated by readback", async () => {
  const fixture = fakeTesterApi({
    testers: [],
    createError: new AscStateError("ASC_API_ERROR", "not_observed", "sanitized failure"),
    createLands: false,
  });
  await assert.rejects(
    inviteBetaTester({ api: fixture.api, email: EMAIL }),
    (error) => error.code === "ASC_API_ERROR" && error.message === "sanitized failure",
  );
});

test("rejects an invite when no internal group exists and never attempts creation", async () => {
  const fixture = fakeTesterApi({ groups: [], testers: [] });
  await assert.rejects(
    inviteBetaTester({ api: fixture.api, email: EMAIL }),
    (error) => error.code === "INTERNAL_GROUP_MISSING",
  );
  assert.equal(fixture.calls.some(([operation]) => operation === "createBetaTester"), false);
});

test("rejects an implausible email before making any API call", async () => {
  const fixture = fakeTesterApi();
  await assert.rejects(
    inviteBetaTester({ api: fixture.api, email: "not-an-email" }),
    (error) => error.code === "INVALID_ARGUMENT",
  );
  assert.equal(fixture.calls.length, 0);
});

test("normalizes and validates beta tester email addresses", () => {
  assert.equal(normalizeBetaTesterEmail(` ${EMAIL} `), EMAIL);
  for (const bad of ["", "not-an-email", "a@b", "@missing-local.com", "trailing@dot."]) {
    assert.throws(
      () => normalizeBetaTesterEmail(bad),
      (error) => error.code === "INVALID_ARGUMENT",
    );
  }
});

test("validates invite CLI arguments", () => {
  assert.deepEqual(
    parseCliArgs([`--email=${EMAIL}`, "--first-name=Dev", "--last-name=Ferri", "--output=/tmp/evidence.json"]),
    { email: EMAIL, firstName: "Dev", lastName: "Ferri", output: "/tmp/evidence.json" },
  );
  assert.deepEqual(parseCliArgs([`--email=${EMAIL}`]), {
    email: EMAIL,
    firstName: undefined,
    lastName: undefined,
    output: undefined,
  });
  for (const args of [
    [],
    [`--email=${EMAIL}`, "--version=1.0.0"],
    ["--email=not-an-email"],
    [`--email=${EMAIL}`, `--email=${EMAIL}`],
  ]) {
    assert.throws(() => parseCliArgs(args));
  }
});
