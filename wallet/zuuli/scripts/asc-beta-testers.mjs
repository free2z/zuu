#!/usr/bin/env node
//
// A beta-tester invite client, deliberately kept out of asc-testflight.mjs.
//
// wallet/zuuli/scripts/release-identity.mjs asserts that the release state
// machine (asc-testflight.mjs) never mentions "betaTesters" — that guard
// keeps tester PII (an email address, a name) categorically unreachable from
// the release path and its evidence artifacts, even by accident. This module
// is the place tester-identity capability is allowed to live. It imports the
// release path's public primitives (JWT signing, the origin/path allowlist,
// the internal-group selector) rather than duplicating the release path's
// own group/build logic, but it implements its own small authenticated
// request helper for the two betaTesters-specific endpoints, because that
// helper is not — and must not become — part of asc-testflight.mjs's public
// surface.

import { createHash } from "node:crypto";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  ASC_API_ROOT,
  ASC_APP_ID,
  ASC_BUNDLE_ID,
  ASC_INTERNAL_GROUP,
  AscStateError,
  REQUEST_TIMEOUT_MS,
  createAscApiClient,
  createAscToken,
  selectInternalGroup,
  validateJwtInputs,
} from "./asc-testflight.mjs";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeBetaTesterEmail(email) {
  const trimmed = String(email ?? "").trim();
  if (trimmed.length < 3 || trimmed.length > 254 || !EMAIL_PATTERN.test(trimmed)) {
    throw new AscStateError(
      "INVALID_ARGUMENT",
      "not_observed",
      "beta tester email must be a plausible email address",
    );
  }
  return trimmed;
}

export function normalizeBetaTesterName(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  const trimmed = String(value).trim();
  if (trimmed.length < 1 || trimmed.length > 100 || /[\r\n\t]/.test(trimmed)) {
    throw new AscStateError(
      "INVALID_ARGUMENT",
      "not_observed",
      `beta tester ${label} must be a plausible single-line name`,
    );
  }
  return trimmed;
}

function emailDigest(email) {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);
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

function relationshipIds(resource, name, expectedType, operation) {
  const data = resource.relationships?.[name]?.data;
  if (!Array.isArray(data)) {
    throw new AscStateError(
      "ASC_INVALID_RESPONSE",
      "not_observed",
      `${operation} is missing the ${name} relationship`,
    );
  }
  for (const item of data) {
    if (item?.type !== expectedType || typeof item.id !== "string") {
      throw new AscStateError(
        "ASC_INVALID_RESPONSE",
        "not_observed",
        `${operation} has a malformed ${name} relationship`,
      );
    }
  }
  return data.map(({ id }) => id);
}

export function createBetaTesterApiClient({
  keyId,
  issuerId,
  privateKey,
  fetchImpl = globalThis.fetch,
  nowSeconds = () => Math.floor(Date.now() / 1000),
}) {
  validateJwtInputs({ keyId, issuerId, privateKey });

  // Group lookup never touches tester identity, so it is delegated verbatim
  // to the release-path ASC client rather than reimplemented here.
  const releaseApi = createAscApiClient({ keyId, issuerId, privateKey, fetchImpl, nowSeconds });

  async function request(method, pathOrUrl, { body, allowEmpty = false } = {}) {
    const url = pathOrUrl instanceof URL ? pathOrUrl : new URL(pathOrUrl, ASC_API_ROOT);
    if (url.origin !== ASC_API_ROOT || !url.pathname.startsWith("/v1/")) {
      throw new AscStateError(
        "ASC_INVALID_REQUEST",
        "not_observed",
        "refusing an App Store Connect request outside the fixed API origin",
      );
    }
    const token = createAscToken({ keyId, issuerId, privateKey, nowSeconds: nowSeconds() });
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
      return await parseResponse(response, `${method} App Store Connect request`, allowEmpty);
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

  return {
    listBetaGroups: releaseApi.listBetaGroups,

    async listBetaTestersByEmail(email) {
      const params = new URLSearchParams({
        "filter[email]": email,
        "fields[betaTesters]": "email,firstName,lastName",
        include: "betaGroups",
        "fields[betaGroups]": "name,isInternalGroup",
        limit: "10",
      });
      const payload = await request("GET", `/v1/betaTesters?${params}`);
      if (!Array.isArray(payload?.data)) {
        throw new AscStateError(
          "ASC_INVALID_RESPONSE",
          "not_observed",
          "beta tester lookup returned malformed data",
        );
      }
      return payload.data.map((item) => {
        const resource = assertResource(item, "betaTesters", "beta tester lookup");
        const betaGroupIds = relationshipIds(resource, "betaGroups", "betaGroups", "beta tester lookup");
        return { id: resource.id, email: resource.attributes.email, betaGroupIds };
      });
    },

    async createBetaTester({ email, firstName, lastName, groupId }) {
      const attributes = { email };
      if (firstName !== undefined) attributes.firstName = firstName;
      if (lastName !== undefined) attributes.lastName = lastName;
      const payload = await request("POST", "/v1/betaTesters", {
        body: {
          data: {
            type: "betaTesters",
            attributes,
            relationships: {
              betaGroups: { data: [{ type: "betaGroups", id: groupId }] },
            },
          },
        },
      });
      const resource = assertResource(payload?.data, "betaTesters", "beta tester creation");
      return { id: resource.id, email: resource.attributes.email };
    },

    async addTesterToGroup(groupId, testerId) {
      await request(
        "POST",
        `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/betaTesters`,
        {
          body: { data: [{ type: "betaTesters", id: testerId }] },
          allowEmpty: true,
        },
      );
    },
  };
}

export function selectBetaTester(candidates, email) {
  if (!Array.isArray(candidates)) {
    throw new AscStateError(
      "ASC_INVALID_RESPONSE",
      "not_observed",
      "beta tester lookup did not return an array",
    );
  }
  const matches = candidates.filter((candidate) => candidate?.email === email);
  if (matches.length > 1) {
    throw new AscStateError(
      "AMBIGUOUS_BETA_TESTER",
      "not_observed",
      `App Store Connect returned ${matches.length} beta testers for the exact email`,
    );
  }
  return matches[0];
}

async function ensureBetaTesterInvited({ api, email, firstName, lastName, group }) {
  let tester = selectBetaTester(await api.listBetaTestersByEmail(email), email);
  if (tester && tester.betaGroupIds.includes(group.id)) {
    return { tester, outcome: "already_in_group", conflictRecovered: false };
  }

  let mutationError;
  try {
    if (tester) {
      await api.addTesterToGroup(group.id, tester.id);
    } else {
      await api.createBetaTester({ email, firstName, lastName, groupId: group.id });
    }
  } catch (error) {
    mutationError = error;
  }

  const confirmed = selectBetaTester(await api.listBetaTestersByEmail(email), email);
  if (!confirmed || !confirmed.betaGroupIds.includes(group.id)) {
    if (mutationError) throw mutationError;
    throw new AscStateError(
      "BETA_TESTER_GROUP_READBACK_FAILED",
      "processed",
      "App Store Connect did not return the invited tester in the configured group after assignment",
      { retryable: true },
    );
  }
  return {
    tester: confirmed,
    // A create/add call that erred but is proven correct by readback means
    // Apple already considered the tester (or the relationship) to exist —
    // that is a success, not a failure, and is reported as such.
    outcome: mutationError ? "already_in_group" : "invited",
    conflictRecovered: Boolean(mutationError),
  };
}

function evidenceForInvite({ group, tester, outcome, conflictRecovered, emailDigest: digest, nowMs }) {
  return {
    schemaVersion: 1,
    application: { id: ASC_APP_ID, bundleId: ASC_BUNDLE_ID },
    mode: "invite",
    tester: {
      id: tester.id,
      emailDigest: digest,
      outcome,
      conflictRecovered,
    },
    group: {
      id: group.id,
      name: ASC_INTERNAL_GROUP,
      isInternalGroup: true,
    },
    observedAt: new Date(nowMs).toISOString(),
  };
}

export async function inviteBetaTester({ api, email, firstName, lastName, nowMs = () => Date.now() }) {
  const normalizedEmail = normalizeBetaTesterEmail(email);
  const normalizedFirstName = normalizeBetaTesterName(firstName, "first name");
  const normalizedLastName = normalizeBetaTesterName(lastName, "last name");
  const groups = await api.listBetaGroups();
  const group = selectInternalGroup(groups);
  const { tester, outcome, conflictRecovered } = await ensureBetaTesterInvited({
    api,
    email: normalizedEmail,
    firstName: normalizedFirstName,
    lastName: normalizedLastName,
    group,
  });
  return evidenceForInvite({
    group,
    tester,
    outcome,
    conflictRecovered,
    emailDigest: emailDigest(normalizedEmail),
    nowMs: nowMs(),
  });
}

export function parseCliArgs(argv) {
  const values = new Map();
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match || values.has(match[1])) {
      throw new AscStateError("INVALID_ARGUMENT", "not_observed", "invalid or duplicate command argument");
    }
    values.set(match[1], match[2]);
  }
  const allowed = new Set(["email", "first-name", "last-name", "output"]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) {
      throw new AscStateError("INVALID_ARGUMENT", "not_observed", "unknown command argument");
    }
  }
  if (!values.has("email")) {
    throw new AscStateError(
      "INVALID_ARGUMENT",
      "not_observed",
      "usage: asc-beta-testers.mjs --email=ADDRESS [--first-name=NAME] [--last-name=NAME] [--output=PATH]",
    );
  }
  return {
    email: normalizeBetaTesterEmail(values.get("email")),
    firstName: values.get("first-name"),
    lastName: values.get("last-name"),
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
  const api = createBetaTesterApiClient({ keyId, issuerId, privateKey });
  const evidence = await inviteBetaTester({
    api,
    email: args.email,
    firstName: args.firstName,
    lastName: args.lastName,
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
          "not_observed",
          "evidence output must be a regular, non-symlink file path",
        );
      }
    }
    await writeFile(args.output, serialized, { encoding: "utf8", mode: 0o600 });
    await chmod(args.output, 0o600);
  }
  process.stdout.write(`${JSON.stringify({ event: "testflight_invite_evidence", ...evidence })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const safe =
      error instanceof AscStateError
        ? error
        : new AscStateError(
            "UNEXPECTED_FAILURE",
            "not_observed",
            "unexpected beta-tester invite failure",
          );
    process.stderr.write(
      `Beta tester invite failed [${safe.code}] at ${safe.stage}: ${safe.message}\n`,
    );
    process.exitCode = 1;
  });
}
