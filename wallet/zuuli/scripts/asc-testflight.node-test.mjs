import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";

import {
  ASC_API_ROOT,
  ASC_APP_ID,
  ASC_BUNDLE_ID,
  ASC_INTERNAL_GROUP,
  AscStateError,
  classifyBuild,
  convergeTestFlightState,
  createAscApiClient,
  createAscToken,
  parseCliArgs,
  selectExactBuild,
  selectInternalGroup,
} from "./asc-testflight.mjs";

const KEY_ID = "AB12CD34EF";
const ISSUER_ID = "12345678-1234-1234-1234-123456789abc";
const VERSION = "0.1.0";
const BUILD = "10";

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKey,
  };
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

function candidate(overrides = {}) {
  return {
    id: "build-10",
    version: BUILD,
    marketingVersion: VERSION,
    platform: "IOS",
    processingState: "VALID",
    usesNonExemptEncryption: false,
    expired: false,
    uploadedDate: "2026-08-10T12:00:00Z",
    internalBuildState: "READY_FOR_BETA_TESTING",
    betaGroupIds: [],
    ...overrides,
  };
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

function fakeApi({
  builds,
  groups = [group()],
  groupBuilds = [],
  addError,
  addLands = true,
} = {}) {
  const calls = [];
  let buildResponses = Array.isArray(builds?.[0]) ? [...builds] : [builds ?? [candidate()]];
  let relationships = [...groupBuilds];
  return {
    calls,
    api: {
      async readApp() {
        calls.push(["readApp"]);
        return {
          type: "apps",
          id: ASC_APP_ID,
          attributes: { bundleId: ASC_BUNDLE_ID, name: "ZUULI", sku: "zuuli-ios" },
        };
      },
      async listBuildCandidates(version, buildNumber) {
        calls.push(["listBuildCandidates", version, buildNumber]);
        return buildResponses.length > 1 ? buildResponses.shift() : buildResponses[0];
      },
      async listBetaGroups() {
        calls.push(["listBetaGroups"]);
        return groups;
      },
      async listGroupBuildIds(groupId) {
        calls.push(["listGroupBuildIds", groupId]);
        return [...relationships];
      },
      async addBuildToGroup(groupId, buildId) {
        calls.push(["addBuildToGroup", groupId, buildId]);
        if (addLands) relationships.push(buildId);
        if (addError) throw addError;
      },
    },
  };
}

test("creates a 15-minute ES256 App Store Connect JWT", () => {
  const { privateKey, publicKey } = keyPair();
  const now = 1_786_196_000;
  const jwt = createAscToken({
    keyId: KEY_ID,
    issuerId: ISSUER_ID,
    privateKey,
    nowSeconds: now,
  });
  const [headerPart, claimsPart, signaturePart] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(headerPart, "base64url")), {
    alg: "ES256",
    kid: KEY_ID,
    typ: "JWT",
  });
  assert.deepEqual(JSON.parse(Buffer.from(claimsPart, "base64url")), {
    iss: ISSUER_ID,
    iat: now,
    exp: now + 900,
    aud: "appstoreconnect-v1",
  });
  assert.equal(Buffer.from(signaturePart, "base64url").length, 64);
  assert.equal(
    verify(
      "sha256",
      Buffer.from(`${headerPart}.${claimsPart}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signaturePart, "base64url"),
    ),
    true,
  );
});

test("rejects malformed credential material without echoing it", () => {
  const secretFragment = "VERY-SECRET-KEY-FRAGMENT";
  assert.throws(
    () =>
      createAscToken({
        keyId: KEY_ID,
        issuerId: ISSUER_ID,
        privateKey: secretFragment,
        nowSeconds: 1,
      }),
    (error) =>
      error.code === "INVALID_CREDENTIAL_CONFIGURATION" &&
      !error.message.includes(secretFragment),
  );
  const { privateKey } = keyPair();
  assert.throws(() =>
    createAscToken({ keyId: "bad", issuerId: ISSUER_ID, privateKey, nowSeconds: 1 }),
  );
  assert.throws(() =>
    createAscToken({ keyId: KEY_ID, issuerId: "bad", privateKey, nowSeconds: 1 }),
  );
});

test("constructs exact app/build/group API requests without tester fields", async () => {
  const { privateKey } = keyPair();
  const mock = queuedFetch([
    jsonResponse({
      data: {
        type: "apps",
        id: ASC_APP_ID,
        attributes: { bundleId: ASC_BUNDLE_ID, name: "ZUULI", sku: "zuuli-ios" },
      },
    }),
    jsonResponse({
      data: [
        {
          type: "builds",
          id: "build-10",
          attributes: {
            version: BUILD,
            uploadedDate: "2026-08-10T12:00:00Z",
            expired: false,
            processingState: "VALID",
            usesNonExemptEncryption: false,
          },
          relationships: {
            preReleaseVersion: { data: { type: "preReleaseVersions", id: "pre-1" } },
            buildBetaDetail: { data: { type: "buildBetaDetails", id: "detail-1" } },
            betaGroups: { data: [{ type: "betaGroups", id: "group-internal" }] },
          },
        },
      ],
      included: [
        {
          type: "preReleaseVersions",
          id: "pre-1",
          attributes: { version: VERSION, platform: "IOS" },
        },
        {
          type: "buildBetaDetails",
          id: "detail-1",
          attributes: { internalBuildState: "IN_BETA_TESTING" },
        },
        {
          type: "betaGroups",
          id: "group-internal",
          attributes: {
            name: ASC_INTERNAL_GROUP,
            isInternalGroup: true,
            hasAccessToAllBuilds: false,
          },
        },
      ],
    }),
    jsonResponse({
      data: [
        {
          type: "betaGroups",
          id: "group-internal",
          attributes: {
            name: ASC_INTERNAL_GROUP,
            isInternalGroup: true,
            hasAccessToAllBuilds: false,
          },
        },
      ],
      links: {},
    }),
    jsonResponse({
      data: [{ type: "builds", id: "build-10", attributes: { version: BUILD } }],
      links: {},
    }),
    new Response(null, { status: 204 }),
  ]);
  const api = createAscApiClient({
    keyId: KEY_ID,
    issuerId: ISSUER_ID,
    privateKey,
    fetchImpl: mock.fetchImpl,
    nowSeconds: () => 1_786_196_000,
  });

  const app = await api.readApp();
  const builds = await api.listBuildCandidates(VERSION, BUILD);
  const groups = await api.listBetaGroups();
  const buildIds = await api.listGroupBuildIds("group-internal");
  await api.addBuildToGroup("group-internal", "build-10");
  assert.equal(app.attributes.bundleId, ASC_BUNDLE_ID);
  assert.deepEqual(builds, [
    candidate({
      internalBuildState: "IN_BETA_TESTING",
      betaGroupIds: ["group-internal"],
    }),
  ]);
  assert.deepEqual(groups, [group()]);
  assert.deepEqual(buildIds, ["build-10"]);
  assert.equal(mock.remaining.length, 0);
  const buildUrl = new URL(mock.calls[1].url);
  assert.equal(buildUrl.origin, ASC_API_ROOT);
  assert.equal(buildUrl.searchParams.get("filter[app]"), ASC_APP_ID);
  assert.equal(buildUrl.searchParams.get("filter[version]"), BUILD);
  assert.equal(buildUrl.searchParams.get("filter[preReleaseVersion.version]"), VERSION);
  assert.equal(buildUrl.searchParams.get("filter[preReleaseVersion.platform]"), "IOS");
  assert.equal(buildUrl.searchParams.toString().includes("betaTesters"), false);
  for (const call of mock.calls) {
    assert.match(call.options.headers.authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
    assert.equal(call.options.signal instanceof AbortSignal, true);
    assert.equal(JSON.stringify(call).includes("email"), false);
  }
  assert.equal(mock.calls[4].options.method, "POST");
  assert.deepEqual(JSON.parse(mock.calls[4].options.body), {
    data: [{ type: "builds", id: "build-10" }],
  });
});

test("accepts an empty exact-build document while Apple has not exposed the upload", async () => {
  const { privateKey } = keyPair();
  const mock = queuedFetch([jsonResponse({ data: [] })]);
  const api = createAscApiClient({
    keyId: KEY_ID,
    issuerId: ISSUER_ID,
    privateKey,
    fetchImpl: mock.fetchImpl,
    nowSeconds: () => 1,
  });
  assert.deepEqual(await api.listBuildCandidates(VERSION, BUILD), []);
});

test("accepts a processing exact build before Apple materializes beta detail", async () => {
  const { privateKey } = keyPair();
  const processingBuild = {
    type: "builds",
    id: "build-10",
    attributes: {
      version: BUILD,
      uploadedDate: "2026-08-10T12:00:00Z",
      expired: false,
      processingState: "PROCESSING",
      usesNonExemptEncryption: null,
    },
    relationships: {
      preReleaseVersion: { data: { type: "preReleaseVersions", id: "pre-1" } },
      buildBetaDetail: { data: null },
      betaGroups: { data: [] },
    },
  };
  const preRelease = {
    type: "preReleaseVersions",
    id: "pre-1",
    attributes: { version: VERSION, platform: "IOS" },
  };
  const { fetchImpl } = queuedFetch([
    jsonResponse({ data: [processingBuild], included: [preRelease] }),
    jsonResponse({
      data: [
        {
          ...processingBuild,
          relationships: {
            ...processingBuild.relationships,
            buildBetaDetail: {
              data: { type: "buildBetaDetails", id: "detail-not-materialized" },
            },
          },
        },
      ],
      included: [preRelease],
    }),
    jsonResponse({
      data: [
        {
          ...processingBuild,
          attributes: { ...processingBuild.attributes, processingState: "FAILED" },
        },
      ],
      included: [preRelease],
    }),
    jsonResponse({
      data: [
        {
          ...processingBuild,
          attributes: { ...processingBuild.attributes, processingState: "INVALID" },
          relationships: {
            preReleaseVersion: processingBuild.relationships.preReleaseVersion,
            betaGroups: { data: [] },
          },
        },
      ],
      included: [preRelease],
    }),
    jsonResponse({
      data: [{ ...processingBuild, attributes: { ...processingBuild.attributes, processingState: "VALID" } }],
      included: [preRelease],
    }),
  ]);
  const api = createAscApiClient({
    keyId: KEY_ID,
    issuerId: ISSUER_ID,
    privateKey,
    fetchImpl,
    nowSeconds: () => 1,
  });
  const [build] = await api.listBuildCandidates(VERSION, BUILD);
  assert.equal(build.internalBuildState, null);
  assert.equal(classifyBuild(build), "uploaded");
  const [linkedBuild] = await api.listBuildCandidates(VERSION, BUILD);
  assert.equal(linkedBuild.internalBuildState, null);
  assert.equal(classifyBuild(linkedBuild), "uploaded");
  const [failedBuild] = await api.listBuildCandidates(VERSION, BUILD);
  assert.equal(failedBuild.internalBuildState, null);
  assert.throws(
    () => classifyBuild(failedBuild),
    (error) => error.code === "PROCESSING_FAILED",
  );
  const [invalidBuild] = await api.listBuildCandidates(VERSION, BUILD);
  assert.equal(invalidBuild.internalBuildState, null);
  assert.throws(
    () => classifyBuild(invalidBuild),
    (error) => error.code === "INVALID_BINARY",
  );
  await assert.rejects(
    api.listBuildCandidates(VERSION, BUILD),
    (error) =>
      error.code === "ASC_INVALID_RESPONSE" &&
      error.message.includes("non-processing build"),
  );
});

test("sanitizes App Store Connect errors and never returns response detail", async () => {
  const { privateKey } = keyPair();
  const secret = "tester@example.invalid secret-token";
  const mock = queuedFetch([
    jsonResponse(
      {
        errors: [
          {
            status: "403",
            code: "FORBIDDEN_ERROR",
            title: "The request is forbidden",
            detail: secret,
          },
        ],
      },
      403,
    ),
  ]);
  const api = createAscApiClient({
    keyId: KEY_ID,
    issuerId: ISSUER_ID,
    privateKey,
    fetchImpl: mock.fetchImpl,
    nowSeconds: () => 1,
  });
  await assert.rejects(
    api.readApp(),
    (error) =>
      error.code === "ASC_API_ERROR" &&
      error.message.includes("FORBIDDEN_ERROR") &&
      !error.message.includes(secret) &&
      !error.message.includes("tester@example"),
  );
});

test("rejects pagination that escapes Apple or exceeds the fixed page bound", async () => {
  const { privateKey } = keyPair();
  const escaped = queuedFetch([
    jsonResponse({ data: [], links: { next: "https://example.invalid/v1/groups?page=2" } }),
  ]);
  const escapedApi = createAscApiClient({
    keyId: KEY_ID,
    issuerId: ISSUER_ID,
    privateKey,
    fetchImpl: escaped.fetchImpl,
    nowSeconds: () => 1,
  });
  await assert.rejects(escapedApi.listBetaGroups(), /escaped the API origin/);

  const pages = Array.from({ length: 5 }, (_, index) =>
    jsonResponse({
      data: [],
      links: { next: `${ASC_API_ROOT}/v1/apps/${ASC_APP_ID}/betaGroups?page=${index + 2}` },
    }),
  );
  const tooMany = queuedFetch(pages);
  const tooManyApi = createAscApiClient({
    keyId: KEY_ID,
    issuerId: ISSUER_ID,
    privateKey,
    fetchImpl: tooMany.fetchImpl,
    nowSeconds: () => 1,
  });
  await assert.rejects(tooManyApi.listBetaGroups(), /exceeded 5 pages/);
});

test("selects only the exact iOS marketing/build identity and rejects duplicates", () => {
  assert.equal(selectExactBuild([candidate()], VERSION, BUILD).id, "build-10");
  assert.equal(selectExactBuild([candidate({ platform: "TV_OS" })], VERSION, BUILD), undefined);
  assert.throws(
    () => selectExactBuild([candidate(), candidate({ id: "duplicate" })], VERSION, BUILD),
    (error) => error.code === "AMBIGUOUS_EXACT_BUILD" && error.stage === "uploaded",
  );
});

test("classifies processing, compliance, invalid, failure, and expired states", () => {
  assert.equal(
    classifyBuild(candidate({ processingState: "PROCESSING", internalBuildState: "PROCESSING" })),
    "uploaded",
  );
  assert.equal(classifyBuild(candidate()), "processed");
  assert.equal(
    classifyBuild(candidate({ internalBuildState: "IN_EXPORT_COMPLIANCE_REVIEW" })),
    "uploaded",
  );
  const cases = [
    [candidate({ processingState: "FAILED", internalBuildState: null }), "PROCESSING_FAILED"],
    [candidate({ processingState: "INVALID", internalBuildState: null }), "INVALID_BINARY"],
    [candidate({ internalBuildState: "PROCESSING_EXCEPTION" }), "PROCESSING_FAILED"],
    [candidate({ internalBuildState: "MISSING_EXPORT_COMPLIANCE" }), "MISSING_EXPORT_COMPLIANCE"],
    [candidate({ usesNonExemptEncryption: undefined }), "MISSING_EXPORT_COMPLIANCE"],
    [candidate({ usesNonExemptEncryption: true }), "UNEXPECTED_NONEXEMPT_ENCRYPTION"],
    [candidate({ internalBuildState: "EXPIRED" }), "BUILD_EXPIRED"],
    [candidate({ expired: true }), "BUILD_EXPIRED"],
    [candidate({ processingState: "NEW_STATE" }), "UNKNOWN_PROCESSING_STATE"],
    [candidate({ internalBuildState: "NEW_STATE" }), "UNKNOWN_INTERNAL_STATE"],
  ];
  for (const [build, code] of cases) {
    assert.throws(() => classifyBuild(build), (error) => error.code === code);
  }
});

test("requires one explicitly named internal group", () => {
  assert.deepEqual(selectInternalGroup([group()]), group());
  assert.throws(() => selectInternalGroup([]), (error) => error.code === "INTERNAL_GROUP_MISSING");
  assert.throws(
    () => selectInternalGroup([group(), group({ id: "duplicate" })]),
    (error) => error.code === "INTERNAL_GROUP_AMBIGUOUS",
  );
  assert.throws(
    () => selectInternalGroup([group({ isInternalGroup: false })]),
    (error) => error.code === "INTERNAL_GROUP_WRONG_TYPE",
  );
});

test("read-only mode verifies an existing relationship without mutating", async () => {
  const fixture = fakeApi({
    builds: [candidate({ internalBuildState: "IN_BETA_TESTING" })],
    groupBuilds: ["build-10"],
  });
  const transitions = [];
  const result = await convergeTestFlightState({
    api: fixture.api,
    version: VERSION,
    build: BUILD,
    mode: "read-only",
    timeoutSeconds: 0,
    pollSeconds: 1,
    nowMs: () => 1_786_196_000_000,
    onTransition: (event) => transitions.push(event.stage),
  });
  assert.deepEqual(result.state, {
    uploaded: true,
    processed: true,
    availableToInternalTesters: true,
  });
  assert.equal(result.mode, "read-only");
  assert.equal(result.group.name, ASC_INTERNAL_GROUP);
  assert.deepEqual(transitions, ["processed", "internal_group_available"]);
  assert.equal(fixture.calls.some(([operation]) => operation === "addBuildToGroup"), false);
  assert.equal(JSON.stringify(result).includes("email"), false);
});

test("refuses an App Store Connect app whose bundle identity does not match", async () => {
  const fixture = fakeApi();
  fixture.api.readApp = async () => ({
    type: "apps",
    id: ASC_APP_ID,
    attributes: { bundleId: "invalid.example.bundle" },
  });
  await assert.rejects(
    convergeTestFlightState({
      api: fixture.api,
      version: VERSION,
      build: BUILD,
      mode: "read-only",
      timeoutSeconds: 0,
      pollSeconds: 1,
    }),
    (error) => error.code === "APP_IDENTITY_MISMATCH" && error.stage === "not_observed",
  );
});

test("ensure mode adds once, reads back, and is idempotent on a rerun", async () => {
  const fixture = fakeApi({ groupBuilds: [] });
  const first = await convergeTestFlightState({
    api: fixture.api,
    version: VERSION,
    build: BUILD,
    mode: "ensure",
    timeoutSeconds: 0,
    pollSeconds: 1,
    nowMs: () => 1_786_196_000_000,
  });
  const second = await convergeTestFlightState({
    api: fixture.api,
    version: VERSION,
    build: BUILD,
    mode: "ensure",
    timeoutSeconds: 0,
    pollSeconds: 1,
    nowMs: () => 1_786_196_001_000,
  });
  assert.equal(first.group.exactBuildRelationshipVerified, true);
  assert.equal(second.group.exactBuildRelationshipVerified, true);
  assert.equal(
    fixture.calls.filter(([operation]) => operation === "addBuildToGroup").length,
    1,
  );
});

test("waits for eventual relationship readback without repeating the assignment", async () => {
  const fixture = fakeApi({ groupBuilds: [] });
  const readRelationship = fixture.api.listGroupBuildIds;
  let relationshipReads = 0;
  fixture.api.listGroupBuildIds = async (...args) => {
    relationshipReads += 1;
    const ids = await readRelationship(...args);
    return relationshipReads === 2 ? [] : ids;
  };
  let current = 1_000;
  const result = await convergeTestFlightState({
    api: fixture.api,
    version: VERSION,
    build: BUILD,
    mode: "ensure",
    timeoutSeconds: 10,
    pollSeconds: 2,
    nowMs: () => current,
    sleep: async (milliseconds) => {
      current += milliseconds;
    },
  });
  assert.equal(result.state.availableToInternalTesters, true);
  assert.equal(relationshipReads, 3);
  assert.equal(
    fixture.calls.filter(([operation]) => operation === "addBuildToGroup").length,
    1,
  );
});

test("an ambiguous POST failure succeeds only when relationship readback proves it landed", async () => {
  const fixture = fakeApi({
    groupBuilds: [],
    addError: new AscStateError("ASC_NETWORK_ERROR", "not_observed", "synthetic failure"),
  });
  const result = await convergeTestFlightState({
    api: fixture.api,
    version: VERSION,
    build: BUILD,
    mode: "ensure",
    timeoutSeconds: 0,
    pollSeconds: 1,
    nowMs: () => 1_786_196_000_000,
  });
  assert.equal(result.state.availableToInternalTesters, true);
});

test("an assignment failure that did not land is reported at the processed stage", async () => {
  const fixture = fakeApi({
    groupBuilds: [],
    addLands: false,
    addError: new AscStateError("ASC_API_ERROR", "not_observed", "sanitized failure"),
  });
  await assert.rejects(
    convergeTestFlightState({
      api: fixture.api,
      version: VERSION,
      build: BUILD,
      mode: "ensure",
      timeoutSeconds: 0,
      pollSeconds: 1,
      nowMs: () => 1_786_196_000_000,
    }),
    (error) =>
      error.code === "ASC_API_ERROR" &&
      error.stage === "processed" &&
      error.message === "sanitized failure",
  );
});

test("read-only mode reports processed-but-unavailable without mutation", async () => {
  const fixture = fakeApi({ groupBuilds: [] });
  await assert.rejects(
    convergeTestFlightState({
      api: fixture.api,
      version: VERSION,
      build: BUILD,
      mode: "read-only",
      timeoutSeconds: 0,
      pollSeconds: 1,
      nowMs: () => 1_786_196_000_000,
    }),
    (error) => error.code === "INTERNAL_GROUP_NOT_AVAILABLE" && error.stage === "processed",
  );
  assert.equal(fixture.calls.some(([operation]) => operation === "addBuildToGroup"), false);
});

test("polls through upload and processing with a fixed deadline", async () => {
  const fixture = fakeApi({
    builds: [
      [],
      [candidate({ processingState: "PROCESSING", internalBuildState: "PROCESSING" })],
      [candidate({ internalBuildState: "IN_BETA_TESTING" })],
    ],
    groupBuilds: ["build-10"],
  });
  let current = 1_000;
  const sleeps = [];
  const transitions = [];
  const result = await convergeTestFlightState({
    api: fixture.api,
    version: VERSION,
    build: BUILD,
    mode: "ensure",
    uploadConfirmed: true,
    timeoutSeconds: 10,
    pollSeconds: 2,
    nowMs: () => current,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      current += milliseconds;
    },
    onTransition: ({ stage }) => transitions.push(stage),
  });
  assert.equal(result.state.availableToInternalTesters, true);
  assert.deepEqual(sleeps, [2_000, 2_000]);
  assert.deepEqual(transitions, ["uploaded", "processed", "internal_group_available"]);
});

test("retries sanitized transient API failures within the same fixed deadline", async () => {
  const fixture = fakeApi({ groupBuilds: ["build-10"] });
  const original = fixture.api.listBuildCandidates;
  let attempts = 0;
  fixture.api.listBuildCandidates = async (...args) => {
    attempts += 1;
    if (attempts === 1) {
      throw new AscStateError(
        "ASC_NETWORK_ERROR",
        "not_observed",
        "synthetic transient failure",
        { retryable: true },
      );
    }
    return original(...args);
  };
  let current = 1_000;
  const result = await convergeTestFlightState({
    api: fixture.api,
    version: VERSION,
    build: BUILD,
    mode: "read-only",
    timeoutSeconds: 10,
    pollSeconds: 2,
    nowMs: () => current,
    sleep: async (milliseconds) => {
      current += milliseconds;
    },
  });
  assert.equal(result.state.availableToInternalTesters, true);
  assert.equal(attempts, 2);
  assert.equal(current, 3_000);
});

test("retries the fixed app identity lookup within the same deadline", async () => {
  const fixture = fakeApi({ groupBuilds: ["build-10"] });
  const readApp = fixture.api.readApp;
  let attempts = 0;
  fixture.api.readApp = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new AscStateError(
        "ASC_NETWORK_ERROR",
        "not_observed",
        "synthetic transient failure",
        { retryable: true },
      );
    }
    return readApp();
  };
  let current = 1_000;
  const result = await convergeTestFlightState({
    api: fixture.api,
    version: VERSION,
    build: BUILD,
    mode: "read-only",
    timeoutSeconds: 10,
    pollSeconds: 2,
    nowMs: () => current,
    sleep: async (milliseconds) => {
      current += milliseconds;
    },
  });
  assert.equal(result.state.availableToInternalTesters, true);
  assert.equal(attempts, 2);
  assert.equal(current, 3_000);
});

test("bounded timeout reports the last proven stage", async () => {
  const fixture = fakeApi({ builds: [[]] });
  let current = 100;
  await assert.rejects(
    convergeTestFlightState({
      api: fixture.api,
      version: VERSION,
      build: BUILD,
      mode: "ensure",
      uploadConfirmed: true,
      timeoutSeconds: 3,
      pollSeconds: 2,
      nowMs: () => current,
      sleep: async (milliseconds) => {
        current += milliseconds;
      },
    }),
    (error) => error.code === "STATE_TIMEOUT" && error.stage === "uploaded",
  );
  assert.equal(current, 3_100);
});

test("validates bounded CLI arguments and explicit mode", () => {
  assert.deepEqual(
    parseCliArgs([
      "--read-only",
      `--version=${VERSION}`,
      `--build=${BUILD}`,
      "--timeout-seconds=120",
      "--poll-seconds=5",
      "--output=/tmp/evidence.json",
    ]),
    {
      version: VERSION,
      build: BUILD,
      mode: "read-only",
      timeoutSeconds: 120,
      pollSeconds: 5,
      output: "/tmp/evidence.json",
    },
  );
  for (const args of [
    [],
    ["--ensure", "--read-only", `--version=${VERSION}`, `--build=${BUILD}`],
    ["--ensure", `--version=${VERSION}`, `--build=${BUILD}`, "--poll-seconds=-1"],
    ["--ensure", `--version=${VERSION}`, `--build=${BUILD}`, "--unknown=x"],
  ]) {
    assert.throws(() => parseCliArgs(args));
  }
});
