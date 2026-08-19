#!/usr/bin/env node

import { createPrivateKey, sign } from "node:crypto";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const ASC_API_ROOT = "https://api.appstoreconnect.apple.com";
export const ASC_APP_ID = "6799322201";
export const ASC_BUNDLE_ID = "cash.free2z.zuuli";
export const ASC_INTERNAL_GROUP = "ZUULI Internal Testers";
export const DEFAULT_TIMEOUT_SECONDS = 45 * 60;
export const DEFAULT_POLL_SECONDS = 30;
export const MAX_TIMEOUT_SECONDS = 60 * 60;
export const MAX_PAGES = 5;
export const REQUEST_TIMEOUT_MS = 30_000;

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BUILD_PATTERN = /^(0|[1-9]\d*)$/;
const KEY_ID_PATTERN = /^[A-Z0-9]{10}$/;
const ISSUER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROCESSING_STATES = new Set(["PROCESSING", "FAILED", "INVALID", "VALID"]);
const INTERNAL_STATES = new Set([
  "PROCESSING",
  "PROCESSING_EXCEPTION",
  "MISSING_EXPORT_COMPLIANCE",
  "READY_FOR_BETA_TESTING",
  "IN_BETA_TESTING",
  "EXPIRED",
  "IN_EXPORT_COMPLIANCE_REVIEW",
]);

export class AscStateError extends Error {
  constructor(code, stage, message, { retryable = false } = {}) {
    super(message);
    this.name = "AscStateError";
    this.code = code;
    this.stage = stage;
    this.retryable = retryable;
  }
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function validateIdentity(version, build) {
  const versionString = String(version ?? "");
  const buildString = String(build ?? "");
  if (!VERSION_PATTERN.test(versionString)) {
    throw new AscStateError(
      "INVALID_IDENTITY",
      "not_observed",
      "marketing version must be a canonical three-component numeric version",
    );
  }
  if (!BUILD_PATTERN.test(buildString)) {
    throw new AscStateError(
      "INVALID_IDENTITY",
      "not_observed",
      "build number must be a canonical nonnegative integer",
    );
  }
  return { version: versionString, build: buildString };
}

export function validateJwtInputs({ keyId, issuerId, privateKey }) {
  if (!KEY_ID_PATTERN.test(keyId ?? "")) {
    throw new AscStateError(
      "INVALID_CREDENTIAL_CONFIGURATION",
      "not_observed",
      "ASC key ID must be ten uppercase alphanumeric characters",
    );
  }
  if (!ISSUER_ID_PATTERN.test(issuerId ?? "")) {
    throw new AscStateError(
      "INVALID_CREDENTIAL_CONFIGURATION",
      "not_observed",
      "ASC issuer ID must be a UUID",
    );
  }
  try {
    const parsed = createPrivateKey(privateKey);
    if (parsed.asymmetricKeyType !== "ec" || parsed.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("not a P-256 key");
    }
    return parsed;
  } catch {
    throw new AscStateError(
      "INVALID_CREDENTIAL_CONFIGURATION",
      "not_observed",
      "ASC private key is not a valid P-256 key",
    );
  }
}

export function createAscToken({ keyId, issuerId, privateKey, nowSeconds }) {
  const parsedKey = validateJwtInputs({ keyId, issuerId, privateKey });
  if (!Number.isInteger(nowSeconds) || nowSeconds < 1) {
    throw new AscStateError(
      "INVALID_CLOCK",
      "not_observed",
      "JWT clock must be a positive integer",
    );
  }
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: issuerId,
      iat: nowSeconds,
      exp: nowSeconds + 15 * 60,
      aud: "appstoreconnect-v1",
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: parsedKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function safeAppleError(payload) {
  const first = Array.isArray(payload?.errors) ? payload.errors[0] : undefined;
  const code =
    typeof first?.code === "string"
      ? first.code.replace(/[^A-Z0-9_.-]/gi, "").slice(0, 80)
      : "UNKNOWN";
  const title =
    typeof first?.title === "string"
      ? first.title.replace(/[^\w .,:;()/-]/g, "").slice(0, 160)
      : "request rejected";
  return `${code}: ${title}`;
}

async function parseResponse(response, operation, allowEmpty = false) {
  const text = await response.text();
  if (!response.ok) {
    let payload;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = undefined;
    }
    throw new AscStateError(
      "ASC_API_ERROR",
      "not_observed",
      `${operation} failed with HTTP ${response.status} (${safeAppleError(payload)})`,
      { retryable: response.status === 429 || response.status >= 500 },
    );
  }
  if (!text) {
    if (allowEmpty) return undefined;
    throw new AscStateError(
      "ASC_INVALID_RESPONSE",
      "not_observed",
      `${operation} returned an empty response`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AscStateError(
      "ASC_INVALID_RESPONSE",
      "not_observed",
      `${operation} returned invalid JSON`,
    );
  }
}

function assertResource(resource, expectedType, operation) {
  if (
    !resource ||
    resource.type !== expectedType ||
    typeof resource.id !== "string" ||
    resource.id.length < 1 ||
    !resource.attributes ||
    typeof resource.attributes !== "object"
  ) {
    throw new AscStateError(
      "ASC_INVALID_RESPONSE",
      "not_observed",
      `${operation} returned a malformed ${expectedType} resource`,
    );
  }
  return resource;
}

function resourceKey(resource) {
  return `${resource.type}:${resource.id}`;
}

function relationshipIds(resource, name, expectedType, many) {
  const data = resource.relationships?.[name]?.data;
  if (many) {
    if (!Array.isArray(data)) {
      throw new AscStateError(
        "ASC_INVALID_RESPONSE",
        "not_observed",
        `build response is missing the ${name} relationship`,
      );
    }
    for (const item of data) {
      if (item?.type !== expectedType || typeof item.id !== "string") {
        throw new AscStateError(
          "ASC_INVALID_RESPONSE",
          "not_observed",
          `build response has a malformed ${name} relationship`,
        );
      }
    }
    return data.map(({ id }) => id);
  }
  if (data?.type !== expectedType || typeof data.id !== "string") {
    throw new AscStateError(
      "ASC_INVALID_RESPONSE",
      "not_observed",
      `build response is missing the ${name} relationship`,
    );
  }
  return [data.id];
}

function checkedNextUrl(next) {
  if (!next) return undefined;
  let parsed;
  try {
    parsed = new URL(next);
  } catch {
    throw new AscStateError(
      "ASC_INVALID_RESPONSE",
      "not_observed",
      "App Store Connect pagination returned an invalid next link",
    );
  }
  if (parsed.origin !== ASC_API_ROOT || !parsed.pathname.startsWith("/v1/")) {
    throw new AscStateError(
      "ASC_INVALID_RESPONSE",
      "not_observed",
      "App Store Connect pagination escaped the API origin",
    );
  }
  return parsed;
}

export function createAscApiClient({
  keyId,
  issuerId,
  privateKey,
  fetchImpl = globalThis.fetch,
  nowSeconds = () => Math.floor(Date.now() / 1000),
}) {
  validateJwtInputs({ keyId, issuerId, privateKey });

  async function request(method, pathOrUrl, { body, allowEmpty = false } = {}) {
    const url = pathOrUrl instanceof URL ? pathOrUrl : new URL(pathOrUrl, ASC_API_ROOT);
    if (url.origin !== ASC_API_ROOT || !url.pathname.startsWith("/v1/")) {
      throw new AscStateError(
        "ASC_INVALID_REQUEST",
        "not_observed",
        "refusing an App Store Connect request outside the fixed API origin",
      );
    }
    const token = createAscToken({
      keyId,
      issuerId,
      privateKey,
      nowSeconds: nowSeconds(),
    });
    const controller = new AbortController();
    const requestTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined
            ? { accept: "application/json" }
            : { accept: "application/json", "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return await parseResponse(
        response,
        `${method} App Store Connect request`,
        allowEmpty,
      );
    } catch (error) {
      if (error instanceof AscStateError) throw error;
      throw new AscStateError(
        "ASC_NETWORK_ERROR",
        "not_observed",
        `${method} App Store Connect request failed before a response`,
        { retryable: true },
      );
    } finally {
      clearTimeout(requestTimer);
    }
  }

  async function paged(path) {
    const resources = [];
    let next = new URL(path, ASC_API_ROOT);
    for (let page = 0; next; page += 1) {
      if (page >= MAX_PAGES) {
        throw new AscStateError(
          "ASC_PAGINATION_LIMIT",
          "not_observed",
          `App Store Connect response exceeded ${MAX_PAGES} pages`,
        );
      }
      const payload = await request("GET", next);
      if (!Array.isArray(payload?.data)) {
        throw new AscStateError(
          "ASC_INVALID_RESPONSE",
          "not_observed",
          "App Store Connect list response has no data array",
        );
      }
      resources.push(...payload.data);
      next = checkedNextUrl(payload.links?.next);
    }
    return resources;
  }

  return {
    async readApp() {
      const params = new URLSearchParams({ "fields[apps]": "name,bundleId,sku" });
      const payload = await request("GET", `/v1/apps/${ASC_APP_ID}?${params}`);
      return assertResource(payload?.data, "apps", "app lookup");
    },

    async listBuildCandidates(version, build) {
      const params = new URLSearchParams({
        "filter[app]": ASC_APP_ID,
        "filter[version]": build,
        "filter[preReleaseVersion.version]": version,
        "filter[preReleaseVersion.platform]": "IOS",
        include: "preReleaseVersion,buildBetaDetail,betaGroups",
        "fields[builds]": [
          "version",
          "uploadedDate",
          "expired",
          "processingState",
          "usesNonExemptEncryption",
          "preReleaseVersion",
          "buildBetaDetail",
          "betaGroups",
        ].join(","),
        "fields[preReleaseVersions]": "version,platform",
        "fields[buildBetaDetails]": "internalBuildState",
        "fields[betaGroups]": "name,isInternalGroup,hasAccessToAllBuilds",
        limit: "200",
      });
      const payload = await request("GET", `/v1/builds?${params}`);
      if (!Array.isArray(payload?.data)) {
        throw new AscStateError(
          "ASC_INVALID_RESPONSE",
          "not_observed",
          "exact build lookup returned malformed relationship data",
        );
      }
      // JSON:API permits `included` to be absent when an exact build has not
      // appeared yet. That is the normal upload-processing polling state, not
      // a malformed response. Once data exists, both requested relationships
      // must still resolve through included resources below.
      const includedResources = payload.included ?? [];
      if (!Array.isArray(includedResources)) {
        throw new AscStateError(
          "ASC_INVALID_RESPONSE",
          "not_observed",
          "exact build lookup returned malformed included resources",
        );
      }
      const included = new Map(
        includedResources.map((item) => [resourceKey(item), item]),
      );
      return payload.data.map((item) => {
        const buildResource = assertResource(item, "builds", "exact build lookup");
        const [preReleaseId] = relationshipIds(
          buildResource,
          "preReleaseVersion",
          "preReleaseVersions",
          false,
        );
        const betaGroupIds = relationshipIds(buildResource, "betaGroups", "betaGroups", true);
        const preRelease = assertResource(
          included.get(`preReleaseVersions:${preReleaseId}`),
          "preReleaseVersions",
          "exact build lookup",
        );
        const processingState = buildResource.attributes.processingState;
        const betaDetailLink = buildResource.relationships?.buildBetaDetail?.data;
        let internalBuildState = null;
        if (betaDetailLink !== null && betaDetailLink !== undefined) {
          if (
            betaDetailLink.type !== "buildBetaDetails" ||
            typeof betaDetailLink.id !== "string"
          ) {
            throw new AscStateError(
              "ASC_INVALID_RESPONSE",
              "not_observed",
              "exact build lookup returned a malformed buildBetaDetail relationship",
            );
          }
          const betaDetail = included.get(`buildBetaDetails:${betaDetailLink.id}`);
          if (betaDetail) {
            internalBuildState = assertResource(
              betaDetail,
              "buildBetaDetails",
              "exact build lookup",
            ).attributes.internalBuildState;
          } else if (processingState === "VALID") {
            throw new AscStateError(
              "ASC_INVALID_RESPONSE",
              "not_observed",
              "exact build lookup omitted build beta detail for a non-processing build",
            );
          }
        } else if (processingState === "VALID") {
          throw new AscStateError(
            "ASC_INVALID_RESPONSE",
            "not_observed",
            "exact build lookup omitted build beta detail for a non-processing build",
          );
        }
        return {
          id: buildResource.id,
          version: buildResource.attributes.version,
          processingState,
          usesNonExemptEncryption: buildResource.attributes.usesNonExemptEncryption,
          expired: buildResource.attributes.expired,
          uploadedDate: buildResource.attributes.uploadedDate,
          marketingVersion: preRelease.attributes.version,
          platform: preRelease.attributes.platform,
          internalBuildState,
          betaGroupIds,
        };
      });
    },

    async listBetaGroups() {
      const params = new URLSearchParams({
        "fields[betaGroups]": "name,isInternalGroup,hasAccessToAllBuilds",
        limit: "200",
      });
      const resources = await paged(`/v1/apps/${ASC_APP_ID}/betaGroups?${params}`);
      return resources.map((item) => {
        const resource = assertResource(item, "betaGroups", "beta group lookup");
        return { id: resource.id, ...resource.attributes };
      });
    },

    async listGroupBuildIds(groupId) {
      const params = new URLSearchParams({ "fields[builds]": "version", limit: "200" });
      const resources = await paged(
        `/v1/betaGroups/${encodeURIComponent(groupId)}/builds?${params}`,
      );
      return resources.map((item) => assertResource(item, "builds", "beta group build lookup").id);
    },

    async addBuildToGroup(groupId, buildId) {
      await request("POST", `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/builds`, {
        body: { data: [{ type: "builds", id: buildId }] },
        allowEmpty: true,
      });
    },
  };
}

export function selectExactBuild(candidates, version, build) {
  if (!Array.isArray(candidates)) {
    throw new AscStateError(
      "ASC_INVALID_RESPONSE",
      "not_observed",
      "build lookup did not return an array",
    );
  }
  const matches = candidates.filter(
    (candidate) =>
      candidate?.version === build &&
      candidate?.marketingVersion === version &&
      candidate?.platform === "IOS",
  );
  if (matches.length > 1) {
    throw new AscStateError(
      "AMBIGUOUS_EXACT_BUILD",
      "uploaded",
      `App Store Connect returned ${matches.length} builds for the exact version and build identity`,
    );
  }
  return matches[0];
}

export function classifyBuild(build) {
  if (!PROCESSING_STATES.has(build.processingState)) {
    throw new AscStateError(
      "UNKNOWN_PROCESSING_STATE",
      "uploaded",
      "App Store Connect returned an unknown build processing state",
    );
  }
  if (build.processingState === "FAILED") {
    throw new AscStateError(
      "PROCESSING_FAILED",
      "uploaded",
      "Apple failed while processing the exact uploaded build; " +
        "inspect App Store Connect for the binary diagnostic",
    );
  }
  if (build.processingState === "INVALID") {
    throw new AscStateError(
      "INVALID_BINARY",
      "uploaded",
      "Apple marked the exact uploaded build invalid; inspect App Store Connect for the binary diagnostic",
    );
  }
  if (build.processingState === "PROCESSING" && build.internalBuildState === null) {
    return "uploaded";
  }
  if (!INTERNAL_STATES.has(build.internalBuildState)) {
    throw new AscStateError(
      "UNKNOWN_INTERNAL_STATE",
      build.processingState === "VALID" ? "processed" : "uploaded",
      "App Store Connect returned an unknown internal TestFlight state",
    );
  }
  if (build.internalBuildState === "PROCESSING_EXCEPTION") {
    throw new AscStateError(
      "PROCESSING_FAILED",
      "uploaded",
      "Apple failed while processing the exact uploaded build; " +
        "inspect App Store Connect for the binary diagnostic",
    );
  }
  if (build.internalBuildState === "MISSING_EXPORT_COMPLIANCE") {
    throw new AscStateError(
      "MISSING_EXPORT_COMPLIANCE",
      "processed",
      "the exact build requires an export-compliance answer before internal testing",
    );
  }
  if (build.internalBuildState === "EXPIRED" || build.expired === true) {
    throw new AscStateError(
      "BUILD_EXPIRED",
      "processed",
      "the exact build is expired and cannot be made available to internal testers",
    );
  }
  if (build.processingState !== "VALID") return "uploaded";
  if (build.usesNonExemptEncryption !== false) {
    throw new AscStateError(
      build.usesNonExemptEncryption === true
        ? "UNEXPECTED_NONEXEMPT_ENCRYPTION"
        : "MISSING_EXPORT_COMPLIANCE",
      "processed",
      build.usesNonExemptEncryption === true
        ? "the exact build unexpectedly declares nonexempt encryption"
        : "the exact build has no resolved export-compliance value",
    );
  }
  if (
    build.internalBuildState === "PROCESSING" ||
    build.internalBuildState === "IN_EXPORT_COMPLIANCE_REVIEW"
  ) {
    return "uploaded";
  }
  return "processed";
}

export function selectInternalGroup(groups) {
  const named = groups.filter((group) => group?.name === ASC_INTERNAL_GROUP);
  if (named.length === 0) {
    throw new AscStateError(
      "INTERNAL_GROUP_MISSING",
      "processed",
      `the configured internal group ${JSON.stringify(ASC_INTERNAL_GROUP)} does not exist`,
    );
  }
  if (named.length > 1) {
    throw new AscStateError(
      "INTERNAL_GROUP_AMBIGUOUS",
      "processed",
      `App Store Connect returned ${named.length} groups with the configured name`,
    );
  }
  if (named[0].isInternalGroup !== true) {
    throw new AscStateError(
      "INTERNAL_GROUP_WRONG_TYPE",
      "processed",
      "the configured TestFlight group is not an internal group",
    );
  }
  return named[0];
}

function evidenceFor({ version, build, exactBuild, group, mode, nowMs }) {
  return {
    schemaVersion: 1,
    application: { id: ASC_APP_ID, bundleId: ASC_BUNDLE_ID },
    identity: { version, build },
    mode,
    state: {
      uploaded: true,
      processed: true,
      availableToInternalTesters: true,
    },
    build: {
      id: exactBuild.id,
      processingState: exactBuild.processingState,
      internalBuildState: exactBuild.internalBuildState,
      usesNonExemptEncryption: exactBuild.usesNonExemptEncryption,
    },
    group: {
      id: group.id,
      name: ASC_INTERNAL_GROUP,
      isInternalGroup: true,
      hasAccessToAllBuilds: group.hasAccessToAllBuilds === true,
      exactBuildRelationshipVerified: true,
    },
    observedAt: new Date(nowMs).toISOString(),
  };
}

export async function convergeTestFlightState({
  api,
  version,
  build,
  mode,
  uploadConfirmed = false,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  pollSeconds = DEFAULT_POLL_SECONDS,
  nowMs = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  onTransition = () => {},
}) {
  ({ version, build } = validateIdentity(version, build));
  if (mode !== "ensure" && mode !== "read-only") {
    throw new AscStateError(
      "INVALID_MODE",
      "not_observed",
      "mode must be ensure or read-only",
    );
  }
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 0 ||
    timeoutSeconds > MAX_TIMEOUT_SECONDS ||
    !Number.isInteger(pollSeconds) ||
    pollSeconds < 1 ||
    pollSeconds > 300
  ) {
    throw new AscStateError(
      "INVALID_POLL_BOUNDS",
      "not_observed",
      "timeout and poll intervals are outside the bounded policy",
    );
  }

  const startedAt = nowMs();
  const deadline = startedAt + timeoutSeconds * 1000;
  let lastStage = uploadConfirmed ? "uploaded" : "not_observed";
  let transitionedStage;
  async function callAtStage(stage, operation) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AscStateError && error.stage === "not_observed") {
        throw new AscStateError(error.code, stage, error.message, {
          retryable: error.retryable,
        });
      }
      throw error;
    }
  }
  async function waitForNextPoll(stage) {
    const current = nowMs();
    if (current >= deadline) {
      throw new AscStateError(
        "STATE_TIMEOUT",
        stage,
        `bounded TestFlight observation timed out at ${stage}`,
      );
    }
    await sleep(Math.min(pollSeconds * 1000, deadline - current));
  }

  let app;
  while (!app) {
    try {
      app = await callAtStage(lastStage, () => api.readApp());
    } catch (error) {
      if (!(error instanceof AscStateError) || !error.retryable) throw error;
      await waitForNextPoll(lastStage);
    }
  }
  if (app.id !== ASC_APP_ID || app.attributes.bundleId !== ASC_BUNDLE_ID) {
    throw new AscStateError(
      "APP_IDENTITY_MISMATCH",
      "not_observed",
      "the configured App Store Connect app does not match the ZUULI bundle",
    );
  }

  while (true) {
    try {
      const candidates = await callAtStage(lastStage, () =>
        api.listBuildCandidates(version, build),
      );
      const exactBuild = selectExactBuild(candidates, version, build);
      if (exactBuild) {
        const stage = classifyBuild(exactBuild);
        if (stage !== transitionedStage) {
          onTransition({ stage, version, build });
          transitionedStage = stage;
        }
        lastStage = stage;
        if (stage === "processed") {
          const groups = await callAtStage("processed", () => api.listBetaGroups());
          const group = selectInternalGroup(groups);
          let groupBuildIds = await callAtStage("processed", () =>
            api.listGroupBuildIds(group.id),
          );
          if (!groupBuildIds.includes(exactBuild.id) && mode === "ensure") {
            let mutationError;
            try {
              await callAtStage("processed", () =>
                api.addBuildToGroup(group.id, exactBuild.id),
              );
            } catch (error) {
              mutationError = error;
            }
            groupBuildIds = await callAtStage("processed", () =>
              api.listGroupBuildIds(group.id),
            );
            if (!groupBuildIds.includes(exactBuild.id) && mutationError) throw mutationError;
          }
          if (groupBuildIds.includes(exactBuild.id)) {
            onTransition({ stage: "internal_group_available", version, build });
            return evidenceFor({ version, build, exactBuild, group, mode, nowMs: nowMs() });
          }
          if (mode === "read-only") {
            throw new AscStateError(
              "INTERNAL_GROUP_NOT_AVAILABLE",
              "processed",
              "the exact processed build is not related to the configured internal group",
            );
          }
          throw new AscStateError(
            "INTERNAL_GROUP_READBACK_FAILED",
            "processed",
            "App Store Connect did not return the exact build from the group after assignment",
            { retryable: true },
          );
        }
      } else if (uploadConfirmed && transitionedStage !== "uploaded") {
        onTransition({ stage: "uploaded", version, build });
        transitionedStage = "uploaded";
      }
    } catch (error) {
      if (!(error instanceof AscStateError) || !error.retryable) throw error;
    }

    await waitForNextPoll(lastStage);
  }
}

function parseIntegerFlag(name, value, fallback) {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new AscStateError(
      "INVALID_ARGUMENT",
      "not_observed",
      `${name} must be a canonical nonnegative integer`,
    );
  }
  return Number(value);
}

export function parseCliArgs(argv) {
  const values = new Map();
  let mode;
  for (const arg of argv) {
    if (arg === "--ensure") {
      if (mode) throw new AscStateError("INVALID_ARGUMENT", "not_observed", "choose exactly one mode");
      mode = "ensure";
      continue;
    }
    if (arg === "--read-only") {
      if (mode) throw new AscStateError("INVALID_ARGUMENT", "not_observed", "choose exactly one mode");
      mode = "read-only";
      continue;
    }
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match || values.has(match[1])) {
      throw new AscStateError("INVALID_ARGUMENT", "not_observed", "invalid or duplicate command argument");
    }
    values.set(match[1], match[2]);
  }
  const allowed = new Set(["version", "build", "timeout-seconds", "poll-seconds", "output"]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) {
      throw new AscStateError("INVALID_ARGUMENT", "not_observed", "unknown command argument");
    }
  }
  if (!mode || !values.has("version") || !values.has("build")) {
    throw new AscStateError(
      "INVALID_ARGUMENT",
      "not_observed",
      "usage: asc-testflight.mjs <--ensure|--read-only> --version=X.Y.Z " +
        "--build=N [--timeout-seconds=N] [--poll-seconds=N] [--output=PATH]",
    );
  }
  return {
    ...validateIdentity(values.get("version"), values.get("build")),
    mode,
    timeoutSeconds: parseIntegerFlag(
      "timeout-seconds",
      values.get("timeout-seconds"),
      DEFAULT_TIMEOUT_SECONDS,
    ),
    pollSeconds: parseIntegerFlag(
      "poll-seconds",
      values.get("poll-seconds"),
      DEFAULT_POLL_SECONDS,
    ),
    output: values.get("output"),
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  const keyPath = process.env.ASC_KEY_PATH;
  if (!keyPath) {
    throw new AscStateError(
      "INVALID_CREDENTIAL_CONFIGURATION",
      "not_observed",
      "ASC_KEY_PATH is required",
    );
  }
  let privateKey;
  try {
    const keyMetadata = await lstat(keyPath);
    if (!keyMetadata.isFile() || keyMetadata.isSymbolicLink()) throw new Error("unsafe key path");
    privateKey = await readFile(keyPath, "utf8");
  } catch {
    throw new AscStateError(
      "INVALID_CREDENTIAL_CONFIGURATION",
      "not_observed",
      "ASC private key could not be read",
    );
  }
  const api = createAscApiClient({ keyId, issuerId, privateKey });
  const evidence = await convergeTestFlightState({
    api,
    ...args,
    uploadConfirmed: args.mode === "ensure",
    onTransition(event) {
      process.stdout.write(`${JSON.stringify({ event: "testflight_state", ...event })}\n`);
    },
  });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (args.output) {
    try {
      const outputMetadata = await lstat(args.output);
      if (!outputMetadata.isFile() || outputMetadata.isSymbolicLink()) {
        throw new Error("unsafe output path");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new AscStateError(
          "INVALID_OUTPUT_PATH",
          "internal_group_available",
          "evidence output must be a regular, non-symlink file path",
        );
      }
    }
    await writeFile(args.output, serialized, { encoding: "utf8", mode: 0o600 });
    await chmod(args.output, 0o600);
  }
  process.stdout.write(`${JSON.stringify({ event: "testflight_evidence", ...evidence })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const safe =
      error instanceof AscStateError
        ? error
        : new AscStateError(
            "UNEXPECTED_FAILURE",
            "not_observed",
            "unexpected TestFlight state-machine failure",
          );
    process.stderr.write(
      `TestFlight state failed [${safe.code}] at ${safe.stage}: ${safe.message}\n`,
    );
    process.exitCode = 1;
  });
}
