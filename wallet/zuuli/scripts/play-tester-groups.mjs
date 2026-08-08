#!/usr/bin/env node

import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PACKAGE_NAME = "cash.free2z.zuuli";
export const TRACK = "internal";
export const EXPECTED_SERVICE_ACCOUNT =
  "corpan-play-verifier@corpora1.iam.gserviceaccount.com";
export const ANDROID_PUBLISHER_SCOPE =
  "https://www.googleapis.com/auth/androidpublisher";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const API_ROOT =
  "https://androidpublisher.googleapis.com/androidpublisher/v3";

const GOOGLE_GROUP_PATTERN =
  /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?@googlegroups\.com$/;

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function validateGoogleGroup(value) {
  if (typeof value !== "string" || !GOOGLE_GROUP_PATTERN.test(value)) {
    throw new Error(
      "google_group must be a lowercase @googlegroups.com address with a 1-64 character local part",
    );
  }
  return value;
}

export function mergeGoogleGroups(existing, requested) {
  validateGoogleGroup(requested);
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new Error("Play testers response googleGroups must be an array");
  }
  const groups = existing ?? [];
  for (const group of groups) {
    if (typeof group !== "string" || group.length < 1) {
      throw new Error("Play testers response contains an invalid Google Group address");
    }
  }
  return [...new Set([...groups, requested])].sort();
}

export function createServiceAccountAssertion(credentials, nowSeconds) {
  if (
    credentials?.type !== "service_account" ||
    credentials?.project_id !== "corpora1" ||
    credentials?.client_email !== EXPECTED_SERVICE_ACCOUNT ||
    typeof credentials?.private_key_id !== "string" ||
    credentials.private_key_id.length < 1
  ) {
    throw new Error("service-account document is not the dedicated ZUULI Play principal");
  }
  if (
    typeof credentials.private_key !== "string" ||
    !credentials.private_key.startsWith("-----BEGIN PRIVATE KEY-----")
  ) {
    throw new Error("service-account document has no private key");
  }
  if (!Number.isInteger(nowSeconds) || nowSeconds < 1) {
    throw new Error("JWT clock must be a positive integer");
  }

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: credentials.client_email,
      scope: ANDROID_PUBLISHER_SCOPE,
      aud: TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(credentials.private_key, "base64url")}`;
}

export function parseServiceAccountDocument(contents) {
  try {
    return JSON.parse(contents);
  } catch {
    // GitHub masks the base64 secret, not arbitrary decoded fragments. Never
    // forward V8's parse error because it can quote part of the private key.
    throw new Error("service-account document is not valid JSON");
  }
}

function safeApiErrorBody(body) {
  if (!body || typeof body !== "object") return "no structured error body";
  const message = body.error?.message ?? body.error_description ?? body.error;
  return typeof message === "string" ? message.slice(0, 500) : "no error message";
}

async function parseJsonResponse(response, operation, allowEmpty = false) {
  const text = await response.text();
  if (!response.ok) {
    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    throw new Error(
      `${operation} failed with HTTP ${response.status}: ${safeApiErrorBody(body)}`,
    );
  }
  if (!text) {
    if (allowEmpty) return undefined;
    throw new Error(`${operation} returned an empty response`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

export function editUrl(editId, suffix = "") {
  const packagePart = encodeURIComponent(PACKAGE_NAME);
  const editPart = editId === undefined ? "" : `/${encodeURIComponent(editId)}`;
  return `${API_ROOT}/applications/${packagePart}/edits${editPart}${suffix}`;
}

export async function getAccessToken(credentials, fetchImpl = globalThis.fetch, nowSeconds) {
  const issuedAt = nowSeconds ?? Math.floor(Date.now() / 1000);
  const assertion = createServiceAccountAssertion(credentials, issuedAt);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await parseJsonResponse(response, "OAuth token exchange");
  if (typeof payload.access_token !== "string" || payload.access_token.length < 1) {
    throw new Error("OAuth token exchange returned no access token");
  }
  return payload.access_token;
}

function createApiClient(accessToken, fetchImpl) {
  async function request(method, url, body, allowEmpty = false) {
    const response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return parseJsonResponse(response, `${method} ${new URL(url).pathname}`, allowEmpty);
  }

  return {
    async insertEdit() {
      const result = await request("POST", editUrl(), {});
      if (typeof result.id !== "string" || result.id.length < 1) {
        throw new Error("Play edit insertion returned no edit ID");
      }
      return result.id;
    },
    getTesters(editId) {
      return request(
        "GET",
        editUrl(editId, `/testers/${encodeURIComponent(TRACK)}`),
      );
    },
    updateTesters(editId, googleGroups) {
      return request(
        "PUT",
        editUrl(editId, `/testers/${encodeURIComponent(TRACK)}`),
        { googleGroups },
      );
    },
    commitEdit(editId) {
      // Tester eligibility does not submit unrelated draft changes for review.
      // A conflicting live edit fails instead of broadening this transaction.
      return request("POST", editUrl(editId, ":commit"));
    },
    deleteEdit(editId) {
      return request("DELETE", editUrl(editId), undefined, true);
    },
  };
}

async function deleteUncommittedEdit(api, editId, primaryError) {
  if (!editId) return;
  try {
    await api.deleteEdit(editId);
  } catch (cleanupError) {
    if (!primaryError) throw cleanupError;
    primaryError.message += `; cleanup also failed: ${cleanupError.message}`;
  }
}

export async function configurePlayTesterGroup({
  credentials,
  googleGroup,
  fetchImpl = globalThis.fetch,
  nowSeconds,
}) {
  const requested = validateGoogleGroup(googleGroup);
  const accessToken = await getAccessToken(credentials, fetchImpl, nowSeconds);
  const api = createApiClient(accessToken, fetchImpl);

  let editId;
  let expectedGroups;
  let primaryError;
  try {
    editId = await api.insertEdit();
    const current = await api.getTesters(editId);
    expectedGroups = mergeGoogleGroups(current.googleGroups, requested);
    const updated = await api.updateTesters(editId, expectedGroups);
    if (
      !updated.googleGroups?.includes(requested) ||
      JSON.stringify(mergeGoogleGroups(updated.googleGroups, requested)) !==
        JSON.stringify(expectedGroups)
    ) {
      throw new Error("Play tester update response did not preserve the requested group set");
    }
    await api.commitEdit(editId);
    editId = undefined;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await deleteUncommittedEdit(api, editId, primaryError);
  }

  let verificationEditId;
  let verificationError;
  try {
    verificationEditId = await api.insertEdit();
    const verified = await api.getTesters(verificationEditId);
    if (!verified.googleGroups?.includes(requested)) {
      throw new Error("fresh Play edit does not contain the requested tester group");
    }
    const groups = mergeGoogleGroups(verified.googleGroups, requested);
    if (JSON.stringify(groups) !== JSON.stringify(expectedGroups)) {
      throw new Error("fresh Play edit does not contain the exact committed tester group set");
    }
    return { packageName: PACKAGE_NAME, track: TRACK, googleGroups: groups };
  } catch (error) {
    verificationError = error;
    throw error;
  } finally {
    await deleteUncommittedEdit(api, verificationEditId, verificationError);
  }
}

export function summarizeConfigurationResult(result, requestedGoogleGroup) {
  return {
    packageName: result.packageName,
    track: result.track,
    requestedGoogleGroup,
    googleGroupCount: result.googleGroups.length,
  };
}

export async function main(env = process.env) {
  const keyPath = env.PLAY_SERVICE_ACCOUNT_JSON;
  if (!keyPath) throw new Error("PLAY_SERVICE_ACCOUNT_JSON is required");
  const googleGroup = validateGoogleGroup(env.ZUULI_PLAY_TESTER_GROUP);
  const credentials = parseServiceAccountDocument(await readFile(keyPath, "utf8"));
  const result = await configurePlayTesterGroup({ credentials, googleGroup });
  process.stdout.write(`${JSON.stringify(summarizeConfigurationResult(result, googleGroup))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Play tester configuration failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
