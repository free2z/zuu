#!/usr/bin/env node

import { createPrivateKey, createSign, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateStoreContract } from "./store-contract.mjs";

export const ASC_ROOT = "https://api.appstoreconnect.apple.com";
export const PLAY_ROOT = "https://androidpublisher.googleapis.com/androidpublisher/v3";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const APPLE_APP_ID = "6799322201";
export const PACKAGE_NAME = "cash.free2z.zuuli";
export const PLAY_TRACK = "internal";
export const EXPECTED_PLAY_ACCOUNT = "corpan-play-verifier@corpora1.iam.gserviceaccount.com";
const MAX_PAGES = 10;
const TIMEOUT_MS = 30_000;

export class StoreAuditError extends Error {
  constructor(code, message, { status } = {}) {
    super(message);
    this.name = "StoreAuditError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, message) {
  throw new StoreAuditError(code, message);
}

function safeError(payload) {
  const raw = payload?.errors?.[0]?.code ?? payload?.error?.status ?? payload?.error?.code;
  return typeof raw === "string" || typeof raw === "number" ? String(raw).replace(/[^A-Z0-9_.-]/gi, "").slice(0, 80) : "UNKNOWN";
}

async function fetchJson(fetchImpl, url, init, operation, { allowEmpty = false, timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  let response;
  let text;
  try {
    response = await fetchImpl(url, { ...init, signal: controller.signal });
    text = await response.text();
  } catch {
    fail("NETWORK_ERROR", `${operation} failed before receiving a response`);
  } finally {
    clearTimeout(timer);
  }
  let payload;
  try { payload = text ? JSON.parse(text) : undefined; } catch { fail("INVALID_RESPONSE", `${operation} returned invalid JSON`); }
  if (!response.ok) throw new StoreAuditError("API_ERROR", `${operation} failed with HTTP ${response.status} (${safeError(payload)})`, { status: response.status });
  if (payload === undefined && !allowEmpty) fail("INVALID_RESPONSE", `${operation} returned an empty response`);
  return payload;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function ascToken(credentials, nowSeconds) {
  if (!/^[A-Z0-9]{10}$/.test(credentials?.keyId ?? "") || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(credentials?.issuerId ?? "")) fail("INVALID_CREDENTIALS", "ASC credential identifiers are malformed");
  let key;
  try { key = createPrivateKey(credentials.privateKey); } catch { fail("INVALID_CREDENTIALS", "ASC private key is malformed"); }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") fail("INVALID_CREDENTIALS", "ASC private key must be P-256");
  const header = base64url(JSON.stringify({ alg: "ES256", kid: credentials.keyId, typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: credentials.issuerId, iat: nowSeconds, exp: nowSeconds + 900, aud: "appstoreconnect-v1" }));
  const input = `${header}.${claims}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

function assertResource(item, type, operation) {
  if (!item || item.type !== type || typeof item.id !== "string" || !item.attributes || typeof item.attributes !== "object") fail("INVALID_RESPONSE", `${operation} returned malformed ${type}`);
  return item;
}

function safeNext(next, root) {
  if (!next) return undefined;
  let url;
  try { url = new URL(next); } catch { fail("INVALID_RESPONSE", "pagination returned an invalid URL"); }
  if (url.origin !== root || !url.pathname.startsWith("/v1/")) fail("INVALID_RESPONSE", "pagination escaped the fixed API origin");
  return url;
}

function fieldsMatch(actual, expected, mapping) {
  if (!expected) return null;
  return Object.entries(mapping).every(([remoteKey, expectedKey]) => actual?.[remoteKey] === expected?.[expectedKey]);
}

export function parsePlayImages(payload) {
  const prototype = payload && typeof payload === "object" ? Object.getPrototypeOf(payload) : undefined;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || prototype !== Object.prototype) fail("INVALID_RESPONSE", "Play images response is malformed");
  if (Object.hasOwn(payload, "error") || Object.hasOwn(payload, "errors")) fail("INVALID_RESPONSE", "Play images response contains an error payload");
  if (!Object.hasOwn(payload, "images")) {
    if (Reflect.ownKeys(payload).length !== 0) fail("INVALID_RESPONSE", "Play images response omitted images alongside unknown members");
    return [];
  }
  if (!Array.isArray(payload.images)) fail("INVALID_RESPONSE", "Play images response has a non-array images member");
  return payload.images;
}

const SAFE_PROVIDER_FAILURE_MESSAGES = Object.freeze({
  AMBIGUOUS_REMOTE_STATE: "provider returned ambiguous duplicate state",
  API_ERROR: "provider API request failed",
  IDENTITY_MISMATCH: "provider application identity did not match ZUULI",
  INVALID_CREDENTIALS: "provider audit credential was invalid",
  INVALID_REQUEST: "provider request escaped the fixed audit scope",
  INVALID_RESPONSE: "provider API returned an invalid response",
  INVALID_SOURCE: "canonical store source was invalid",
  MISSING_CREDENTIALS: "provider audit credential was not configured",
  NETWORK_ERROR: "provider request failed before receiving a response",
  PAGINATION_LIMIT: "provider audit exceeded its page limit",
  TRANSACTION_TIMEOUT: "provider audit exceeded its transaction deadline",
});

function sanitizedProviderFailure(provider, error) {
  if (!(error instanceof StoreAuditError)) return { provider, code: "STORE_AUDIT_FAILED", message: "provider audit failed unexpectedly" };
  const message = SAFE_PROVIDER_FAILURE_MESSAGES[error.code];
  return message ? { provider, code: error.code, message } : { provider, code: "STORE_AUDIT_FAILED", message: "provider audit failed unexpectedly" };
}

export async function auditAppleStore({ credentials, expected, fetchImpl = globalThis.fetch, nowSeconds = () => Math.floor(Date.now() / 1000) }) {
  async function get(pathOrUrl) {
    const url = pathOrUrl instanceof URL ? pathOrUrl : new URL(pathOrUrl, ASC_ROOT);
    if (url.origin !== ASC_ROOT || !url.pathname.startsWith("/v1/")) fail("INVALID_REQUEST", "refusing Apple request outside the fixed API origin");
    return fetchJson(fetchImpl, url, { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${ascToken(credentials, nowSeconds())}` } }, "App Store Connect read");
  }
  async function list(path) {
    const result = [];
    let next = new URL(path, ASC_ROOT);
    for (let page = 0; next; page += 1) {
      if (page === MAX_PAGES) fail("PAGINATION_LIMIT", "App Store Connect audit exceeded its page limit");
      const payload = await get(next);
      if (!Array.isArray(payload?.data)) fail("INVALID_RESPONSE", "App Store Connect list response has no data array");
      result.push(...payload.data);
      next = safeNext(payload.links?.next, ASC_ROOT);
    }
    return result;
  }

  const appPayload = await get(`/v1/apps/${APPLE_APP_ID}?fields%5Bapps%5D=name%2CbundleId`);
  const app = assertResource(appPayload?.data, "apps", "app lookup");
  if (app.id !== expected.application.appleAppId || app.attributes.bundleId !== expected.application.bundleId) fail("IDENTITY_MISMATCH", "App Store Connect application identity does not match ZUULI");

  const infos = await list(`/v1/apps/${APPLE_APP_ID}/appInfos?limit=200`);
  const betaLocales = await list(`/v1/apps/${APPLE_APP_ID}/betaAppLocalizations?limit=200`);
  const versionFilter = expected.release?.version ? `&filter%5BversionString%5D=${encodeURIComponent(expected.release.version)}` : "";
  const versions = await list(`/v1/apps/${APPLE_APP_ID}/appStoreVersions?filter%5Bplatform%5D=IOS${versionFilter}&limit=200`);
  if (versions.length > 1) fail("AMBIGUOUS_REMOTE_STATE", "App Store Connect returned duplicate exact-version records");
  for (const item of [...infos, ...betaLocales, ...versions]) {
    if (!item || typeof item.id !== "string" || typeof item.type !== "string") fail("INVALID_RESPONSE", "App Store Connect listing response contains a malformed resource");
  }
  const expectedLocales = new Set(expected.locales.map(({ appleLocale }) => appleLocale));
  const betaLocaleNames = new Set(betaLocales.map((item) => item.attributes?.locale).filter((value) => typeof value === "string"));
  const infoLocaleNames = new Set();
  const infoByLocale = new Map();
  for (const info of infos) {
    const infoLocales = await list(`/v1/appInfos/${encodeURIComponent(info.id)}/appInfoLocalizations?limit=200`);
    for (const item of infoLocales) {
      assertResource(item, "appInfoLocalizations", "app info localization lookup");
      if (typeof item.attributes.locale === "string") {
        if (infoByLocale.has(item.attributes.locale)) fail("AMBIGUOUS_REMOTE_STATE", "App Store Connect returned a duplicate app-info locale");
        infoLocaleNames.add(item.attributes.locale);
        infoByLocale.set(item.attributes.locale, item.attributes);
      }
    }
  }
  const betaByLocale = new Map();
  for (const item of betaLocales) {
    assertResource(item, "betaAppLocalizations", "beta localization lookup");
    const locale = item.attributes.locale;
    if (typeof locale !== "string") fail("INVALID_RESPONSE", "beta localization has no locale");
    if (betaByLocale.has(locale)) fail("AMBIGUOUS_REMOTE_STATE", "App Store Connect returned a duplicate beta locale");
    betaByLocale.set(locale, item.attributes);
  }
  const versionByLocale = new Map();
  const declaredAppleSets = expected.screenshotSets.filter(({ provider }) => provider === "apple");
  const remoteSetCounts = new Map();
  for (const version of versions) {
    const versionLocales = await list(`/v1/appStoreVersions/${encodeURIComponent(version.id)}/appStoreVersionLocalizations?limit=200`);
    for (const versionLocale of versionLocales) {
      assertResource(versionLocale, "appStoreVersionLocalizations", "version localization lookup");
      const locale = versionLocale.attributes.locale;
      if (!expectedLocales.has(locale)) continue;
      if (versionByLocale.has(locale)) fail("AMBIGUOUS_REMOTE_STATE", `App Store Connect returned duplicate ${locale} exact-version localizations`);
      versionByLocale.set(locale, versionLocale.attributes);
      const sets = await list(`/v1/appStoreVersionLocalizations/${encodeURIComponent(versionLocale.id)}/appScreenshotSets?limit=200`);
      for (const set of sets) {
        assertResource(set, "appScreenshotSets", "screenshot set lookup");
        const type = set.attributes.screenshotDisplayType;
        if (typeof type !== "string") fail("INVALID_RESPONSE", "App Store Connect screenshot set has no display type");
        const screenshots = await list(`/v1/appScreenshotSets/${encodeURIComponent(set.id)}/appScreenshots?limit=200`);
        for (const screenshot of screenshots) assertResource(screenshot, "appScreenshots", "screenshot lookup");
        const key = `${locale}:${type}`;
        if (remoteSetCounts.has(key)) fail("AMBIGUOUS_REMOTE_STATE", "App Store Connect returned duplicate locale/display-type screenshot sets");
        remoteSetCounts.set(key, screenshots.length);
      }
    }
  }
  const observedLocales = expected.locales.map(({ appleLocale: locale, appleMetadata }) => ({
    locale,
    appInfoPresent: infoLocaleNames.has(locale),
    appInfoMatched: fieldsMatch(infoByLocale.get(locale), appleMetadata, { name: "name", subtitle: "subtitle", privacyPolicyUrl: "privacyPolicyUrl" }),
    betaInfoPresent: betaLocaleNames.has(locale),
    betaInfoMatched: fieldsMatch(betaByLocale.get(locale), appleMetadata, { description: "betaDescription", feedbackEmail: "betaFeedbackEmail" }),
    exactVersionInfoPresent: versionByLocale.has(locale),
    exactVersionInfoMatched: fieldsMatch(versionByLocale.get(locale), appleMetadata, { description: "description", keywords: "keywords", marketingUrl: "marketingUrl", promotionalText: "promotionalText", supportUrl: "supportUrl", whatsNew: "releaseNotes" }),
  }));
  const screenshotSets = declaredAppleSets.map(({ id, apiType, locale, minCount, count }) => ({ id, apiType, locale, expectedMinimum: minCount, localDeclaredCount: count, remoteCount: remoteSetCounts.get(`${locale}:${apiType}`) ?? 0 }));
  return {
    provider: "apple",
    readOnly: true,
    identityMatched: true,
    localeState: observedLocales,
    versionCount: versions.length,
    screenshotSets,
    complete: observedLocales.every(({ appInfoMatched, betaInfoMatched, exactVersionInfoMatched }) => appInfoMatched === true && betaInfoMatched === true && exactVersionInfoMatched === true) && screenshotSets.every(({ remoteCount, expectedMinimum }) => remoteCount >= expectedMinimum),
  };
}

function validatePlayCredentials(credentials) {
  if (credentials?.type !== "service_account" || credentials.project_id !== "corpora1" || credentials.client_email !== EXPECTED_PLAY_ACCOUNT || typeof credentials.private_key !== "string" || typeof credentials.private_key_id !== "string" || typeof credentials.token_uri !== "string") fail("INVALID_CREDENTIALS", "Play credential is not the dedicated ZUULI service-account document");
  if (credentials.token_uri !== TOKEN_URL) fail("INVALID_CREDENTIALS", "Play credential has an unexpected token endpoint");
}

function playAssertion(credentials, nowSeconds) {
  validatePlayCredentials(credentials);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: credentials.client_email, scope: "https://www.googleapis.com/auth/androidpublisher", aud: TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 }));
  const input = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(input);
  signer.end();
  try {
    return `${input}.${signer.sign(credentials.private_key, "base64url")}`;
  } catch {
    fail("INVALID_CREDENTIALS", "Play credential private key is malformed");
  }
}

export async function auditPlayStore({ credentials, expected, fetchImpl = globalThis.fetch, nowSeconds = () => Math.floor(Date.now() / 1000), nowMillis = () => Date.now(), sleepImpl = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)), transactionTimeoutMs = 120_000 }) {
  const assertion = playAssertion(credentials, nowSeconds());
  const tokenPayload = await fetchJson(fetchImpl, TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) }, "Play OAuth exchange");
  if (typeof tokenPayload?.access_token !== "string" || tokenPayload.access_token.length < 1) fail("INVALID_RESPONSE", "Play OAuth exchange returned no access token");
  const base = `${PLAY_ROOT}/applications/${encodeURIComponent(PACKAGE_NAME)}/edits`;
  const deadline = nowMillis() + transactionTimeoutMs;
  async function request(method, url, body, allowEmpty = false) {
    if (!url.startsWith(`${base}/`) && url !== base) fail("INVALID_REQUEST", "refusing Play request outside the fixed package edit scope");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (nowMillis() >= deadline) fail("TRANSACTION_TIMEOUT", "Play read transaction exceeded its bounded deadline");
      try {
        return await fetchJson(fetchImpl, url, { method, headers: { authorization: `Bearer ${tokenPayload.access_token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, `Play ${method} read transaction`, { allowEmpty, timeoutMs: Math.min(TIMEOUT_MS, deadline - nowMillis()) });
      } catch (error) {
        const retryable = error instanceof StoreAuditError && error.code === "API_ERROR" && (error.status === 429 || error.status >= 500) && new Set(["GET", "DELETE"]).has(method);
        if (!retryable || attempt === 2 || nowMillis() + 250 * (attempt + 1) >= deadline) throw error;
        await sleepImpl(250 * (attempt + 1));
      }
    }
    fail("TRANSACTION_TIMEOUT", "Play read transaction exhausted its retry budget");
  }
  let editId;
  let primaryError;
  try {
    const inserted = await request("POST", base, {});
    if (typeof inserted?.id === "string" && inserted.id.length >= 1 && inserted.id.length <= 200) editId = inserted.id;
    if (!editId || !/^[A-Za-z0-9_-]{1,200}$/.test(editId)) fail("INVALID_RESPONSE", "Play edit insertion returned an invalid edit ID");
    const editBase = `${base}/${encodeURIComponent(editId)}`;
    const listings = await request("GET", `${editBase}/listings`);
    if (!Array.isArray(listings?.listings)) fail("INVALID_RESPONSE", "Play listings response has no listings array");
    const expectedLocales = new Set(expected.locales.map(({ playLocale }) => playLocale));
    const localeState = expected.locales.map(({ playLocale: locale, playMetadata }) => {
      const matches = listings.listings.filter((listing) => listing?.language === locale);
      if (matches.length > 1) fail("AMBIGUOUS_REMOTE_STATE", `Play returned duplicate ${locale} listings`);
      return { locale, listingPresent: matches.length === 1, listingMatched: fieldsMatch(matches[0], playMetadata, { title: "title", shortDescription: "shortDescription", fullDescription: "fullDescription" }) };
    });
    const details = await request("GET", `${editBase}/details`);
    if (!details || typeof details !== "object" || Array.isArray(details)) fail("INVALID_RESPONSE", "Play app details response is malformed");
    const defaultMetadata = expected.locales.find(({ id }) => id === expected.application.defaultLocale)?.playMetadata;
    if (!defaultMetadata) fail("INVALID_SOURCE", "default Play locale metadata is missing");
    const detailsMatched = details.defaultLanguage === expected.application.defaultLocale && details.contactEmail === defaultMetadata.supportEmail && details.contactWebsite === defaultMetadata.websiteUrl;
    const track = await request("GET", `${editBase}/tracks/${PLAY_TRACK}`);
    if (track?.track !== PLAY_TRACK || !Array.isArray(track.releases)) fail("INVALID_RESPONSE", "Play internal-track response is malformed");
    const exactReleases = track.releases.filter((release) => Array.isArray(release?.versionCodes) && release.versionCodes.includes(String(expected.release.build)));
    if (exactReleases.length > 1) fail("AMBIGUOUS_REMOTE_STATE", "Play returned duplicate releases for the exact build");
    const exactRelease = exactReleases[0];
    const remoteNotes = new Map();
    for (const note of exactRelease?.releaseNotes ?? []) {
      if (typeof note?.language !== "string" || typeof note?.text !== "string" || remoteNotes.has(note.language)) fail("INVALID_RESPONSE", "Play exact release has malformed or duplicate localized notes");
      remoteNotes.set(note.language, note.text);
    }
    const releaseNotes = expected.locales.map(({ playLocale: locale, playMetadata }) => ({ locale, matched: exactRelease === undefined ? false : remoteNotes.get(locale) === playMetadata.releaseNotes }));
    const imageTypes = ["icon", "featureGraphic", ...expected.screenshotSets.filter(({ provider }) => provider === "play").map(({ apiType }) => apiType)];
    const imageState = [];
    const brandDigestByType = new Map([
      ["icon", expected.brandMedia?.find(({ id }) => id === "play-store-icon")?.sha256],
      ["featureGraphic", expected.brandMedia?.find(({ id }) => id === "play-feature-graphic")?.sha256],
    ]);
    for (const locale of expectedLocales) {
      for (const imageType of imageTypes) {
        const payload = await request("GET", `${editBase}/listings/${encodeURIComponent(locale)}/${encodeURIComponent(imageType)}`);
        const images = parsePlayImages(payload);
        for (const image of images) if (typeof image?.id !== "string") fail("INVALID_RESPONSE", "Play images response contains malformed media");
        const expectedDigest = brandDigestByType.get(imageType);
        imageState.push({ locale, imageType, count: images.length, contentMatched: expectedDigest === undefined ? null : images.length === 1 && images[0].sha256 === expectedDigest });
      }
    }
    let testerMode = "publisher_api_unavailable";
    let groupCount = null;
    try {
      const testers = await request("GET", `${editBase}/testers/${PLAY_TRACK}`);
      if (!Array.isArray(testers?.googleGroups)) fail("INVALID_RESPONSE", "Play testers response has no googleGroups array");
      for (const group of testers.googleGroups) if (typeof group !== "string") fail("INVALID_RESPONSE", "Play testers response contains malformed group configuration");
      groupCount = testers.googleGroups.length;
      testerMode = groupCount === 0 ? "no_api_visible_google_groups" : "publisher_api_google_groups";
    } catch (error) {
      if (!(error instanceof StoreAuditError) || error.code !== "API_ERROR" || !new Set([403, 404]).has(error.status)) throw error;
    }
    return {
      provider: "play",
      readOnly: true,
      transaction: "temporary_edit_deleted_without_commit",
      identityMatched: expected.application.playPackageName === PACKAGE_NAME,
      localeState,
      details: { present: true, matched: detailsMatched },
      exactRelease: { build: expected.release.build, present: exactRelease !== undefined, releaseNotes },
      imageState,
      testerEligibility: {
        ownerDeclaredMode: "console_email_list",
        publisherApiObservation: testerMode,
        publisherApiGroupCount: groupCount,
        emailListIdentitiesReadable: false,
        managedByThisPipeline: false,
        consistentWithOwnerMode: groupCount === null ? null : groupCount === 0,
      },
      complete: detailsMatched && localeState.every(({ listingMatched }) => listingMatched === true) && releaseNotes.every(({ matched }) => matched) && imageState.filter(({ imageType }) => new Set(["icon", "featureGraphic"]).has(imageType)).every(({ contentMatched }) => contentMatched === true) && expected.screenshotSets.filter(({ provider }) => provider === "play").every(({ apiType, minCount }) => imageState.some((image) => image.imageType === apiType && image.count >= minCount)),
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (editId) {
      try { await request("DELETE", `${base}/${encodeURIComponent(editId)}`, undefined, true); }
      catch (cleanupError) {
        if (!primaryError) throw cleanupError;
        primaryError.message += "; temporary Play edit cleanup also failed";
      }
    }
  }
}

export function parseAuditArgs(argv) {
  const result = {};
  for (const arg of argv) {
    const match = arg.match(/^--(provider|output)=(.+)$/);
    if (!match || result[match[1]] !== undefined) fail("INVALID_ARGUMENT", `invalid or duplicate argument: ${arg}`);
    result[match[1]] = match[2];
  }
  if (!new Set(["apple", "play", "both"]).has(result.provider)) fail("INVALID_ARGUMENT", "--provider must be apple, play, or both");
  if (!result.output) fail("INVALID_ARGUMENT", "--output is required");
  return result;
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const validate = dependencies.validate ?? validateStoreContract;
  const read = dependencies.read ?? readFile;
  const write = dependencies.write ?? writeFile;
  const auditApple = dependencies.auditApple ?? auditAppleStore;
  const auditPlay = dependencies.auditPlay ?? auditPlayStore;
  const args = parseAuditArgs(argv);
  const expected = await validate();
  const evidence = { schemaVersion: 1, contractPhase: expected.phase, publicationReady: expected.publicationReady, sourceIdentity: { ...expected.application, release: expected.release }, providers: [], providerFailures: [] };
  if (args.provider === "apple" || args.provider === "both") {
    try {
      if (!env.ASC_KEY_PATH || !env.ASC_KEY_ID || !env.ASC_ISSUER_ID) fail("MISSING_CREDENTIALS", "ASC audit credential is not configured");
      evidence.providers.push(await auditApple({ credentials: { keyId: env.ASC_KEY_ID, issuerId: env.ASC_ISSUER_ID, privateKey: await read(env.ASC_KEY_PATH, "utf8") }, expected }));
    } catch (error) {
      evidence.providerFailures.push(sanitizedProviderFailure("apple", error));
    }
  }
  if (args.provider === "play" || args.provider === "both") {
    try {
      if (!env.PLAY_SERVICE_ACCOUNT_JSON) fail("MISSING_CREDENTIALS", "Play audit credential is not configured");
      let credentials;
      try { credentials = JSON.parse(await read(env.PLAY_SERVICE_ACCOUNT_JSON, "utf8")); } catch { fail("INVALID_CREDENTIALS", "Play credential document is invalid JSON"); }
      evidence.providers.push(await auditPlay({ credentials, expected }));
    } catch (error) {
      evidence.providerFailures.push(sanitizedProviderFailure("play", error));
    }
  }
  const outputPath = resolve(args.output);
  await write(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ auditedProviders: evidence.providers.map(({ provider }) => provider), failedProviders: evidence.providerFailures.map(({ provider }) => provider), complete: evidence.providerFailures.length === 0 && evidence.providers.every(({ complete }) => complete) })}\n`);
  if (evidence.providerFailures.length > 0) {
    const summary = evidence.providerFailures.map(({ provider, code, message }) => `${provider} ${code}: ${message}`).join("; ");
    fail("PROVIDER_AUDIT_FAILED", `${summary}; sanitized evidence written`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(error instanceof StoreAuditError ? `${error.code}: ${error.message}\n` : "STORE_AUDIT_FAILED: store audit failed unexpectedly\n");
    process.exitCode = 1;
  });
}
