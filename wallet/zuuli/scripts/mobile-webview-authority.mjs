#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Exact commands exercised by the current mobile product. In particular this
// omits the unused generic seed-reveal command, raw viewing/spending keys,
// wallet deletion/switching/renaming, account creation, endpoint mutation, and
// send-all proposal authority. Backup-seed access remains because onboarding
// currently uses that wallet-ID-bound command.
export const REVIEWED_MOBILE_ZCASH_PERMISSIONS = [
  "zcash:allow-create-wallet",
  "zcash:allow-restore-wallet",
  "zcash:allow-get-wallet-status",
  "zcash:allow-preview-legacy-wallet-import",
  "zcash:allow-retry-wallet-cleanup",
  "zcash:allow-get-backup-seed-phrase",
  "zcash:allow-confirm-wallet-backup",
  "zcash:allow-begin-sensitive-display",
  "zcash:allow-begin-sensitive-entry",
  "zcash:allow-end-sensitive-display",
  "zcash:allow-list-accounts",
  "zcash:allow-get-account-balance",
  "zcash:allow-get-unified-address",
  "zcash:allow-start-sync",
  "zcash:allow-stop-sync",
  "zcash:allow-get-sync-status",
  "zcash:allow-ensure-sapling-params",
  "zcash:allow-propose-send",
  "zcash:allow-confirm-send",
  "zcash:allow-execute-send",
  "zcash:allow-discard-send-proposal",
  "zcash:allow-get-pending-send",
  "zcash:allow-retry-pending-send",
  "zcash:allow-discard-unrecoverable-send",
  "zcash:allow-get-transaction-history",
  "zcash:allow-parse-payment-uri",
  "zcash:allow-validate-address",
  "zcash:allow-sign-challenge",
];

const REVIEWED_NON_WALLET_PERMISSIONS = [
  "core:default",
  "deep-link:default",
  "opener:default",
  "http:default",
];
const REVIEWED_HTTP_URLS = [
  "https://free2z.cash/*",
  "https://stage.free2z.cash/*",
];

function exactSet(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.some((value) => !actual.includes(value))
  ) {
    throw new Error(`${label} differs from its exact reviewed allowlist`);
  }
}

function cspDirective(csp, name) {
  for (const directive of csp.split(";")) {
    const tokens = directive.trim().split(/\s+/).filter(Boolean);
    if (tokens[0] === name) return tokens.slice(1);
  }
  return null;
}

export function assertMobileWebviewAuthority(mobile, tauriConfig) {
  exactSet(mobile.platforms ?? [], ["iOS", "android"], "mobile platforms");
  exactSet(mobile.windows ?? [], ["main"], "mobile capability windows");

  if (!Array.isArray(mobile.permissions)) {
    throw new Error("mobile permissions must be an array");
  }
  const permissionIds = mobile.permissions.map((permission) =>
    typeof permission === "string" ? permission : permission?.identifier,
  );
  if (permissionIds.some((identifier) => typeof identifier !== "string")) {
    throw new Error("every mobile permission must have an identifier");
  }
  if (permissionIds.includes("zcash:default")) {
    throw new Error("mobile main must not receive zcash:default");
  }

  const walletPermissions = permissionIds.filter((identifier) =>
    identifier.startsWith("zcash:"),
  );
  exactSet(
    walletPermissions,
    REVIEWED_MOBILE_ZCASH_PERMISSIONS,
    "mobile Zcash permissions",
  );
  if (
    mobile.permissions.some(
      (permission) =>
        typeof permission === "object" &&
        permission?.identifier?.startsWith("zcash:"),
    )
  ) {
    throw new Error(
      "named mobile Zcash command permissions must be plain identifiers",
    );
  }
  exactSet(
    permissionIds.filter((identifier) => !identifier.startsWith("zcash:")),
    REVIEWED_NON_WALLET_PERMISSIONS,
    "mobile non-wallet permissions",
  );

  const httpPermission = mobile.permissions.find(
    (permission) =>
      typeof permission === "object" &&
      permission?.identifier === "http:default",
  );
  if (!httpPermission || !Array.isArray(httpPermission.allow)) {
    throw new Error(
      "mobile HTTP permission must retain its exact scoped allowlist",
    );
  }
  if (
    mobile.permissions.some(
      (permission) =>
        typeof permission === "object" && permission !== httpPermission,
    )
  ) {
    throw new Error(
      "only the reviewed mobile HTTP permission may carry scope data",
    );
  }
  exactSet(
    httpPermission.allow.map((entry) => entry?.url),
    REVIEWED_HTTP_URLS,
    "mobile HTTP URLs",
  );

  const csp = tauriConfig?.app?.security?.csp;
  if (typeof csp !== "string") {
    throw new Error("packaged Tauri CSP must be a string");
  }
  const frameSources = cspDirective(csp, "frame-src");
  if (
    !frameSources ||
    frameSources.length !== 1 ||
    frameSources[0] !== "'none'"
  ) {
    throw new Error("privileged native WebViews must declare frame-src 'none'");
  }
}

export async function main() {
  const [mobile, tauriConfig] = await Promise.all([
    readFile(
      new URL("../src-tauri/capabilities/mobile.json", import.meta.url),
      "utf8",
    ).then(JSON.parse),
    readFile(
      new URL("../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ).then(JSON.parse),
  ]);
  assertMobileWebviewAuthority(mobile, tauriConfig);
  console.log(
    `Mobile main has ${REVIEWED_MOBILE_ZCASH_PERMISSIONS.length} named Zcash permissions and native frames are disabled.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
