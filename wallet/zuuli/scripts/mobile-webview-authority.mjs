#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Exact commands exercised by the current mobile product. In particular this
// omits the unused generic seed-reveal command, raw viewing/spending keys,
// wallet deletion/renaming, account creation, endpoint mutation, and
// send-all proposal authority. Backup-seed access remains because onboarding
// currently uses that wallet-ID-bound command.
export const REVIEWED_MOBILE_ZCASH_PERMISSIONS = [
  "zcash:allow-create-wallet",
  "zcash:allow-restore-wallet",
  "zcash:allow-get-wallet-status",
  "zcash:allow-list-wallets",
  "zcash:allow-switch-wallet",
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

// Exact commands the mobile messaging product exercises:
// `CLIENT-CONTRACT.md` §3's whole plugin surface **except**
// `set_relay_trust`.
//
// That one omission is the reviewed decision, and it is the same one
// `tauri-plugin-f2zmsg/permissions/default.toml` flags on the desktop grant:
// `set_relay_trust` is how a user opts in to a relay advertising
// `transport_security: "none"` or `channel_binding_mode: "none"` (`WIRE.md`
// §2.3, §5.3) — the only grant in the set that is a security downgrade.
// `add_relay` already refuses such a relay and records it `refused`, so a store
// build that never grants the opt-in cannot be talked into routing messages in
// the clear, and a `wss://` relay is added without it.
//
// The enrollment trio is absent for a different reason and must stay absent:
// `f2zmsg_enroll`, `f2zmsg_enrollment_status` and `f2zmsg_unenroll` are
// app-crate commands (§2.2), not plugin commands, so no capability grants them
// and none should try.
export const REVIEWED_MOBILE_F2ZMSG_PERMISSIONS = [
  "f2zmsg:allow-get-engine-status",
  "f2zmsg:allow-start-engine",
  "f2zmsg:allow-stop-engine",
  "f2zmsg:allow-get-device-info",
  "f2zmsg:allow-list-conversations",
  "f2zmsg:allow-get-conversation",
  "f2zmsg:allow-start-conversation",
  "f2zmsg:allow-list-contact-requests",
  "f2zmsg:allow-accept-contact-request",
  "f2zmsg:allow-reject-contact-request",
  "f2zmsg:allow-leave-conversation",
  "f2zmsg:allow-send-message",
  "f2zmsg:allow-retry-send",
  "f2zmsg:allow-cancel-send",
  "f2zmsg:allow-list-messages",
  "f2zmsg:allow-get-message",
  "f2zmsg:allow-get-delivery-state",
  "f2zmsg:allow-mark-read",
  "f2zmsg:allow-get-receipt-policy",
  "f2zmsg:allow-set-receipt-policy",
  "f2zmsg:allow-list-gaps",
  "f2zmsg:allow-request-gap-repair",
  "f2zmsg:allow-get-retention-policy",
  "f2zmsg:allow-set-retention-policy",
  "f2zmsg:allow-send-ephemeral-hint",
  "f2zmsg:allow-get-ephemeral-hint",
  "f2zmsg:allow-send-purge-request",
  "f2zmsg:allow-list-purge-requests",
  "f2zmsg:allow-resolve-handle",
  "f2zmsg:allow-check-handle-eligibility",
  "f2zmsg:allow-get-safety-number",
  "f2zmsg:allow-set-verification",
  "f2zmsg:allow-get-self-audit-state",
  "f2zmsg:allow-list-alarms",
  "f2zmsg:allow-acknowledge-alarm",
  "f2zmsg:allow-list-relays",
  "f2zmsg:allow-add-relay",
  "f2zmsg:allow-remove-relay",
  "f2zmsg:allow-get-relay-capabilities",
  "f2zmsg:allow-list-witnesses",
  "f2zmsg:allow-set-witness-set",
  "f2zmsg:allow-get-witness-set-state",
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
  for (const blanket of ["zcash:default", "f2zmsg:default"]) {
    if (permissionIds.includes(blanket)) {
      throw new Error(`mobile main must not receive ${blanket}`);
    }
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
  const messagingPermissions = permissionIds.filter((identifier) =>
    identifier.startsWith("f2zmsg:"),
  );
  exactSet(
    messagingPermissions,
    REVIEWED_MOBILE_F2ZMSG_PERMISSIONS,
    "mobile messaging permissions",
  );
  if (
    mobile.permissions.some(
      (permission) =>
        typeof permission === "object" &&
        permission?.identifier?.startsWith("f2zmsg:"),
    )
  ) {
    throw new Error(
      "named mobile messaging command permissions must be plain identifiers",
    );
  }
  exactSet(
    permissionIds.filter(
      (identifier) =>
        !identifier.startsWith("zcash:") && !identifier.startsWith("f2zmsg:"),
    ),
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
    `Mobile main has ${REVIEWED_MOBILE_ZCASH_PERMISSIONS.length} named Zcash ` +
      `and ${REVIEWED_MOBILE_F2ZMSG_PERMISSIONS.length} named messaging ` +
      `permissions, and native frames are disabled.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
