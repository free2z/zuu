import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { auditAppleStore, auditPlayStore, main, parsePlayImages, StoreAuditError } from "./store-state-audit.mjs";

const expected = {
  release: { version: "0.1.0", build: 10 },
  application: { appleAppId: "6799322201", bundleId: "cash.free2z.zuuli", playPackageName: "cash.free2z.zuuli", defaultLocale: "en-US" },
  locales: [{ id: "en-US", appleLocale: "en-US", playLocale: "en-US", appleMetadata: { name: "ZUULI", subtitle: "Creator tools", privacyPolicyUrl: "https://example.com/privacy", betaDescription: "beta", betaFeedbackEmail: "help@example.com", description: "description", keywords: "zcash", marketingUrl: "https://example.com/", promotionalText: "promo", supportUrl: "https://example.com/support", releaseNotes: "notes" }, playMetadata: { title: "ZUULI", shortDescription: "short", fullDescription: "full", releaseNotes: "release notes", supportEmail: "help@example.com", websiteUrl: "https://example.com/" } }],
  brandMedia: [{ id: "play-store-icon", sha256: "a".repeat(64) }, { id: "play-feature-graphic", sha256: "a".repeat(64) }],
  screenshotSets: [
    { id: "apple-phone", provider: "apple", apiType: "APP_IPHONE_67", locale: "en-US", minCount: 4, count: 0 },
    { id: "apple-tablet", provider: "apple", apiType: "APP_IPAD_PRO_3GEN_129", locale: "en-US", minCount: 4, count: 0 },
    { id: "play-phone", provider: "play", apiType: "phoneScreenshots", locale: "en-US", minCount: 4, count: 0 },
    { id: "play-small", provider: "play", apiType: "sevenInchScreenshots", locale: "en-US", minCount: 4, count: 0 },
    { id: "play-large", provider: "play", apiType: "tenInchScreenshots", locale: "en-US", minCount: 4, count: 0 },
  ],
};

const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const appleCredentials = {
  keyId: "ABCDEFGHIJ",
  issuerId: "11111111-2222-3333-4444-555555555555",
  privateKey: ec.privateKey.export({ type: "pkcs8", format: "pem" }),
};
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const playCredentials = {
  type: "service_account",
  project_id: "corpora1",
  client_email: "corpan-play-verifier@corpora1.iam.gserviceaccount.com",
  private_key_id: "key-id",
  private_key: rsa.privateKey.export({ type: "pkcs8", format: "pem" }),
  token_uri: "https://oauth2.googleapis.com/token",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function list(data, next = null) {
  return json({ data, links: { next } });
}

test("Apple audit is GET-only, bounded, identity-pinned, and sanitized", async () => {
  const methods = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    methods.push(init.method);
    assert.equal(init.method, "GET");
    assert.match(init.headers.authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
    if (url.pathname === "/v1/apps/6799322201") return json({ data: { type: "apps", id: "6799322201", attributes: { name: "ZUULI", bundleId: "cash.free2z.zuuli" } } });
    if (url.pathname.endsWith("/appInfos")) return list([{ type: "appInfos", id: "info", attributes: { appStoreState: "READY_FOR_SALE" } }]);
    if (url.pathname.endsWith("/appInfoLocalizations")) return list([{ type: "appInfoLocalizations", id: "info-en", attributes: { locale: "en-US", name: "ZUULI", subtitle: "Creator tools", privacyPolicyUrl: "https://example.com/privacy" } }]);
    if (url.pathname.endsWith("/betaAppLocalizations")) return list([{ type: "betaAppLocalizations", id: "beta-en", attributes: { locale: "en-US", description: "beta", feedbackEmail: "help@example.com" } }]);
    if (url.pathname.endsWith("/appStoreVersions")) {
      assert.equal(url.searchParams.get("filter[platform]"), "IOS");
      assert.equal(url.searchParams.get("filter[versionString]"), "0.1.0");
      return list([{ type: "appStoreVersions", id: "version", attributes: { platform: "IOS" } }]);
    }
    if (url.pathname.endsWith("/appStoreVersionLocalizations")) return list([{ type: "appStoreVersionLocalizations", id: "version-en", attributes: { locale: "en-US", description: "description", keywords: "zcash", marketingUrl: "https://example.com/", promotionalText: "promo", supportUrl: "https://example.com/support", whatsNew: "notes" } }]);
    if (url.pathname.endsWith("/appScreenshotSets")) return list([{ type: "appScreenshotSets", id: "phone-set", attributes: { screenshotDisplayType: "APP_IPHONE_67" } }]);
    if (url.pathname.endsWith("/appScreenshots")) return list(Array.from({ length: 4 }, (_, index) => ({ type: "appScreenshots", id: `shot-${index}`, attributes: { fileName: `shot-${index}.png` } })));
    throw new Error(`unexpected URL ${url}`);
  };
  const evidence = await auditAppleStore({ credentials: appleCredentials, expected, fetchImpl, nowSeconds: () => 1_800_000_000 });
  assert.equal(methods.every((method) => method === "GET"), true);
  assert.equal(evidence.readOnly, true);
  assert.equal(evidence.identityMatched, true);
  assert.deepEqual(evidence.screenshotSets.map(({ remoteCount }) => remoteCount), [4, 0]);
  assert.deepEqual(evidence.localeState[0], { locale: "en-US", appInfoPresent: true, appInfoMatched: true, betaInfoPresent: true, betaInfoMatched: true, exactVersionInfoPresent: true, exactVersionInfoMatched: true });
  assert.equal(JSON.stringify(evidence).includes("fileName"), false);
  assert.equal(evidence.complete, false);
});

test("Apple audit rejects pagination outside the fixed API origin", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/v1/apps/6799322201") return json({ data: { type: "apps", id: "6799322201", attributes: { bundleId: "cash.free2z.zuuli" } } });
    return list([], "https://attacker.invalid/v1/apps");
  };
  await assert.rejects(() => auditAppleStore({ credentials: appleCredentials, expected, fetchImpl, nowSeconds: () => 1_800_000_000 }), (error) => error instanceof StoreAuditError && error.code === "INVALID_RESPONSE");
});

test("Apple audit rejects duplicate locale/display-type screenshot sets", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/v1/apps/6799322201") return json({ data: { type: "apps", id: "6799322201", attributes: { bundleId: "cash.free2z.zuuli" } } });
    if (url.pathname.endsWith("/appInfos") || url.pathname.endsWith("/betaAppLocalizations")) return list([]);
    if (url.pathname.endsWith("/appStoreVersions")) return list([{ type: "appStoreVersions", id: "version", attributes: { platform: "IOS" } }]);
    if (url.pathname.endsWith("/appStoreVersionLocalizations")) return list([{ type: "appStoreVersionLocalizations", id: "version-en", attributes: { locale: "en-US" } }]);
    if (url.pathname.endsWith("/appScreenshotSets")) return list([
      { type: "appScreenshotSets", id: "duplicate-a", attributes: { screenshotDisplayType: "APP_IPHONE_67" } },
      { type: "appScreenshotSets", id: "duplicate-b", attributes: { screenshotDisplayType: "APP_IPHONE_67" } },
    ]);
    if (url.pathname.endsWith("/appScreenshots")) return list([]);
    throw new Error(`unexpected URL ${url}`);
  };
  await assert.rejects(() => auditAppleStore({ credentials: appleCredentials, expected, fetchImpl, nowSeconds: () => 1_800_000_000 }), (error) => error instanceof StoreAuditError && error.code === "AMBIGUOUS_REMOTE_STATE");
});

function playMock({ groups = [], invalidListings = false, editId = "audit-edit", listingFailures = 0, deleteFailures = 0, testerStatus = 200, listingTitle = "ZUULI", releaseNotes = "release notes", missingBrandType, duplicateBrandType, imagePayload } = {}) {
  const calls = [];
  let remainingListingFailures = listingFailures;
  let remainingDeleteFailures = deleteFailures;
  return {
    calls,
    async fetch(input, init) {
      const url = new URL(input);
      calls.push({ method: init.method, pathname: url.pathname });
      if (url.origin === "https://oauth2.googleapis.com") return json({ access_token: "ephemeral-token" });
      if (init.method === "POST" && url.pathname.endsWith("/edits")) return json({ id: editId });
      if (init.method === "DELETE") {
        if (remainingDeleteFailures-- > 0) return json({ error: { status: "UNAVAILABLE" } }, 503);
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/listings")) {
        if (remainingListingFailures-- > 0) return json({ error: { status: "UNAVAILABLE" } }, 503);
        return invalidListings ? json({}) : json({ listings: [{ language: "en-US", title: listingTitle, shortDescription: "short", fullDescription: "full" }] });
      }
      if (url.pathname.endsWith("/details")) return json({ defaultLanguage: "en-US", contactEmail: "help@example.com", contactWebsite: "https://example.com/" });
      if (url.pathname.endsWith("/tracks/internal")) return json({ track: "internal", releases: [{ versionCodes: ["10"], releaseNotes: [{ language: "en-US", text: releaseNotes }] }] });
      if (url.pathname.endsWith("/testers/internal")) return testerStatus === 200 ? json({ googleGroups: groups }) : json({ error: { status: "PERMISSION_DENIED" } }, testerStatus);
      if (url.pathname.includes("/listings/en-US/")) {
        if (imagePayload !== undefined) return json(imagePayload);
        const imageType = url.pathname.split("/").at(-1);
        const count = imageType === missingBrandType ? 0 : imageType === duplicateBrandType ? 2 : new Set(["phoneScreenshots", "sevenInchScreenshots", "tenInchScreenshots"]).has(imageType) ? 4 : 1;
        return json({ images: Array.from({ length: count }, (_, index) => ({ id: `${imageType}-${index}`, sha256: "a".repeat(64) })) });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  };
}

test("Play audit deletes its temporary edit, never commits, and reports email-list mode without identities", async () => {
  const mock = playMock();
  const evidence = await auditPlayStore({ credentials: playCredentials, expected, fetchImpl: mock.fetch, nowSeconds: () => 1_800_000_000 });
  assert.equal(evidence.transaction, "temporary_edit_deleted_without_commit");
  assert.equal(evidence.complete, true);
  assert.equal(evidence.testerEligibility.ownerDeclaredMode, "console_email_list");
  assert.equal(evidence.testerEligibility.publisherApiObservation, "no_api_visible_google_groups");
  assert.equal(evidence.testerEligibility.emailListIdentitiesReadable, false);
  assert.equal(mock.calls.filter(({ method }) => method === "POST").length, 2); // OAuth and insert only.
  assert.equal(mock.calls.some(({ pathname }) => pathname.endsWith(":commit")), false);
  assert.equal(mock.calls.some(({ method }) => method === "PUT"), false);
  assert.equal(mock.calls.at(-1).method, "DELETE");
});

test("Play group configuration is flagged without logging group addresses", async () => {
  const marker = "private-review-group@googlegroups.com";
  const mock = playMock({ groups: [marker] });
  const evidence = await auditPlayStore({ credentials: playCredentials, expected, fetchImpl: mock.fetch, nowSeconds: () => 1_800_000_000 });
  assert.equal(evidence.testerEligibility.publisherApiObservation, "publisher_api_google_groups");
  assert.equal(evidence.testerEligibility.consistentWithOwnerMode, false);
  assert.equal(JSON.stringify(evidence).includes(marker), false);
});

test("Play completeness rejects stale listing copy", async () => {
  const mock = playMock({ listingTitle: "Old title" });
  const evidence = await auditPlayStore({ credentials: playCredentials, expected, fetchImpl: mock.fetch, nowSeconds: () => 1_800_000_000 });
  assert.equal(evidence.localeState[0].listingPresent, true);
  assert.equal(evidence.localeState[0].listingMatched, false);
  assert.equal(evidence.complete, false);
});

test("Play completeness rejects stale exact-build release notes", async () => {
  const mock = playMock({ releaseNotes: "old notes" });
  const evidence = await auditPlayStore({ credentials: playCredentials, expected, fetchImpl: mock.fetch, nowSeconds: () => 1_800_000_000 });
  assert.equal(evidence.exactRelease.present, true);
  assert.equal(evidence.exactRelease.releaseNotes[0].matched, false);
  assert.equal(evidence.complete, false);
});

test("Play completeness requires hash-matched icon and feature media", async () => {
  const mock = playMock({ missingBrandType: "featureGraphic" });
  const evidence = await auditPlayStore({ credentials: playCredentials, expected, fetchImpl: mock.fetch, nowSeconds: () => 1_800_000_000 });
  const feature = evidence.imageState.find(({ imageType }) => imageType === "featureGraphic");
  assert.equal(feature.count, 0);
  assert.equal(feature.contentMatched, false);
  assert.equal(evidence.complete, false);
});

test("Play treats the live empty image-list object as exactly zero images", async () => {
  const mock = playMock({ imagePayload: {} });
  const evidence = await auditPlayStore({ credentials: playCredentials, expected, fetchImpl: mock.fetch, nowSeconds: () => 1_800_000_000 });
  assert.equal(evidence.imageState.length, 5);
  assert.equal(evidence.imageState.every(({ count }) => count === 0), true);
  assert.equal(evidence.imageState.find(({ imageType }) => imageType === "icon").contentMatched, false);
  assert.equal(evidence.complete, false);
  assert.equal(mock.calls.at(-1).method, "DELETE");
});

test("Play accepts only an exact plain empty object when images is absent", () => {
  assert.deepEqual(parsePlayImages({}), []);
  for (const payload of [{ foo: "bar" }, Object.create(null), new Date("2026-08-19T00:00:00Z")]) {
    assert.throws(() => parsePlayImages(payload), (error) => error instanceof StoreAuditError && error.code === "INVALID_RESPONSE");
  }
});

test("Play rejects malformed, explicit-null, non-array, and error image payloads", async () => {
  for (const imagePayload of [null, [], "", { foo: "bar" }, { images: null }, { images: {} }, { error: { status: "FAILED_PRECONDITION" } }, { errors: [{ code: "FAILED_PRECONDITION" }] }]) {
    const mock = playMock({ imagePayload });
    await assert.rejects(
      () => auditPlayStore({ credentials: playCredentials, expected, fetchImpl: mock.fetch, nowSeconds: () => 1_800_000_000 }),
      (error) => error instanceof StoreAuditError && error.code === "INVALID_RESPONSE",
    );
    assert.equal(mock.calls.at(-1).method, "DELETE");
  }
});

test("Play singleton brand media rejects duplicate remote assets", async () => {
  const mock = playMock({ duplicateBrandType: "icon" });
  const evidence = await auditPlayStore({ credentials: playCredentials, expected, fetchImpl: mock.fetch, nowSeconds: () => 1_800_000_000 });
  const icon = evidence.imageState.find(({ imageType }) => imageType === "icon");
  assert.equal(icon.count, 2);
  assert.equal(icon.contentMatched, false);
  assert.equal(evidence.complete, false);
});

test("Play API-unavailable tester state remains unknown, not inferred as email-list proof", async () => {
  const mock = playMock({ testerStatus: 403 });
  const evidence = await auditPlayStore({ credentials: playCredentials, expected, fetchImpl: mock.fetch, nowSeconds: () => 1_800_000_000 });
  assert.equal(evidence.testerEligibility.publisherApiObservation, "publisher_api_unavailable");
  assert.equal(evidence.testerEligibility.consistentWithOwnerMode, null);
  assert.equal(evidence.testerEligibility.managedByThisPipeline, false);
});

test("Play audit cleans up the temporary edit when a read fails", async () => {
  const mock = playMock({ invalidListings: true });
  await assert.rejects(() => auditPlayStore({ credentials: playCredentials, expected, fetchImpl: mock.fetch, nowSeconds: () => 1_800_000_000 }), (error) => error instanceof StoreAuditError && error.code === "INVALID_RESPONSE");
  assert.equal(mock.calls.at(-1).method, "DELETE");
  assert.equal(mock.calls.some(({ pathname }) => pathname.endsWith(":commit")), false);
});

test("Play audit retains a bounded malformed edit ID for best-effort cleanup", async () => {
  const mock = playMock({ editId: "unexpected edit id" });
  await assert.rejects(() => auditPlayStore({ credentials: playCredentials, expected, fetchImpl: mock.fetch, nowSeconds: () => 1_800_000_000 }), (error) => error instanceof StoreAuditError && error.code === "INVALID_RESPONSE");
  assert.equal(mock.calls.at(-1).method, "DELETE");
  assert.match(mock.calls.at(-1).pathname, /unexpected%20edit%20id$/);
  assert.equal(mock.calls.some(({ pathname }) => pathname.endsWith(":commit")), false);
});

test("Play retries only GET and DELETE without repeating edit insertion", async () => {
  const mock = playMock({ listingFailures: 1, deleteFailures: 1 });
  const evidence = await auditPlayStore({ credentials: playCredentials, expected, fetchImpl: mock.fetch, nowSeconds: () => 1_800_000_000, sleepImpl: async () => {} });
  assert.equal(evidence.complete, true);
  assert.equal(mock.calls.filter(({ method, pathname }) => method === "POST" && pathname.endsWith("/edits")).length, 1);
  assert.equal(mock.calls.filter(({ method, pathname }) => method === "GET" && pathname.endsWith("/listings")).length, 2);
  assert.equal(mock.calls.filter(({ method }) => method === "DELETE").length, 2);
});

test("Play cleanup reports when the single transaction deadline is exhausted", async () => {
  let clock = 0;
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ method: init.method, pathname: url.pathname });
    if (url.origin === "https://oauth2.googleapis.com") return json({ access_token: "ephemeral-token" });
    if (init.method === "POST" && url.pathname.endsWith("/edits")) return json({ id: "audit-edit" });
    if (url.pathname.endsWith("/listings")) {
      clock = 101;
      throw new Error("simulated network stall");
    }
    throw new Error("request should not begin after deadline");
  };
  await assert.rejects(
    () => auditPlayStore({ credentials: playCredentials, expected, fetchImpl, nowSeconds: () => 1_800_000_000, nowMillis: () => clock, transactionTimeoutMs: 100 }),
    (error) => error instanceof StoreAuditError && error.code === "NETWORK_ERROR" && error.message.includes("cleanup also failed"),
  );
  assert.equal(calls.filter(({ method, pathname }) => method === "POST" && pathname.endsWith("/edits")).length, 1);
  assert.equal(calls.some(({ method }) => method === "DELETE"), false);
});

test("combined audit writes sanitized successful-provider and failure evidence before rejecting", async () => {
  let written;
  await assert.rejects(
    () => main(
      ["--provider=both", "--output=store-state.json"],
      { ASC_KEY_PATH: "apple-key", ASC_KEY_ID: "ABCDEFGHIJ", ASC_ISSUER_ID: "11111111-2222-3333-4444-555555555555", PLAY_SERVICE_ACCOUNT_JSON: "play-key" },
      {
        validate: async () => ({ ...expected, phase: "foundation", publicationReady: false }),
        read: async (path) => path === "play-key" ? JSON.stringify(playCredentials) : appleCredentials.privateKey,
        write: async (_path, contents, options) => { written = { contents, options }; },
        auditApple: async () => ({ provider: "apple", readOnly: true, complete: false }),
        auditPlay: async () => { throw new StoreAuditError("INVALID_RESPONSE", "Play images response has a non-array images member"); },
      },
    ),
    (error) => error instanceof StoreAuditError && error.code === "PROVIDER_AUDIT_FAILED" && error.message.includes("play INVALID_RESPONSE"),
  );
  assert.equal(written.options.mode, 0o600);
  const evidence = JSON.parse(written.contents);
  assert.deepEqual(evidence.providers, [{ provider: "apple", readOnly: true, complete: false }]);
  assert.deepEqual(evidence.providerFailures, [{ provider: "play", code: "INVALID_RESPONSE", message: "provider API returned an invalid response" }]);
});

test("provider failures never copy hostile remote strings into evidence or the verdict", async () => {
  const marker = "attacker+locale@example.invalid Bearer hostile-token locale-SECRET";
  let written;
  await assert.rejects(
    () => main(
      ["--provider=play", "--output=store-state.json"],
      { PLAY_SERVICE_ACCOUNT_JSON: "play-key" },
      {
        validate: async () => ({ ...expected, phase: "foundation", publicationReady: false }),
        read: async () => JSON.stringify(playCredentials),
        write: async (_path, contents) => { written = contents; },
        auditPlay: async () => { throw new StoreAuditError("INVALID_RESPONSE", `duplicate remote locale ${marker}`); },
      },
    ),
    (error) => error instanceof StoreAuditError && error.code === "PROVIDER_AUDIT_FAILED" && !error.message.includes(marker),
  );
  assert.equal(written.includes(marker), false);
  assert.deepEqual(JSON.parse(written).providerFailures, [{ provider: "play", code: "INVALID_RESPONSE", message: "provider API returned an invalid response" }]);
});

test("unexpected provider failures remain generic", async () => {
  const marker = "private credential marker";
  let written;
  await assert.rejects(
    () => main(
      ["--provider=play", "--output=store-state.json"],
      { PLAY_SERVICE_ACCOUNT_JSON: "play-key" },
      {
        validate: async () => ({ ...expected, phase: "foundation", publicationReady: false }),
        read: async () => JSON.stringify(playCredentials),
        write: async (_path, contents) => { written = contents; },
        auditPlay: async () => { throw new Error(marker); },
      },
    ),
    (error) => error instanceof StoreAuditError && error.code === "PROVIDER_AUDIT_FAILED" && !error.message.includes(marker),
  );
  assert.equal(written.includes(marker), false);
  assert.deepEqual(JSON.parse(written).providerFailures, [{ provider: "play", code: "STORE_AUDIT_FAILED", message: "provider audit failed unexpectedly" }]);
});
