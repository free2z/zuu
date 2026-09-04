#!/usr/bin/env node
//
// The delegated surfaces hold no privilege they were not granted by review.
//
// #904 splits ZUULI into three apps because a WebView that renders third-party
// content must not sit next to seed access. That split is only worth anything
// if it is mechanical: "free2z has no wallet capability" is a property that a
// one-line edit can quietly reverse, and the edit looks like every other
// capability edit. So it is asserted here, in the shape
// `mobile-webview-authority.mjs` already uses for ZUULI's own mobile webview.
//
// Two independent surfaces are checked per app, because a capability file and a
// Cargo manifest can each grant authority the other does not mention:
//
//   * CAPABILITY FILES. Every `src-tauri/capabilities/*.json` — enumerated off
//     the filesystem, never listed, so a new capability file cannot escape by
//     being added — must satisfy the app's reviewed namespace contract.
//   * THE CARGO MANIFEST. A capability can only address a command the process
//     actually registers, so the deeper guarantee is that the privileged plugin
//     is not linked at all. `free2z` must link neither `tauri-plugin-zcash` nor
//     `tauri-plugin-f2zmsg`; `e2e2z` must link `tauri-plugin-f2zmsg` and never
//     `tauri-plugin-zcash`.
//
// The contract per app:
//
//   free2z  — the content surface. NO `zcash:*` and NO `f2zmsg:*` entry, ever.
//             This is the whole point of the split: this is the process that
//             renders embeds, remote images and livestream SDKs, and #367's
//             frame confusion means a remote subframe there resolves as the
//             trusted main window. It must find nothing privileged to call.
//   e2e2z   — the messaging surface. NO `zcash:*` entry, ever: ongoing
//             messaging never needs the seed (docs/e2ee/ARCHITECTURE.md §4.2).
//             Messaging grants are named commands only — never the blanket
//             `f2zmsg:default` — and each must be in the reviewed allowlist
//             `mobile-webview-authority.mjs` already holds ZUULI's mobile
//             webview to, so the two cannot drift into disagreeing about what
//             a messaging client needs.
//
// Usage:
//   node wallet/zuuli/scripts/surface-capability-authority.mjs
//   node --test wallet/zuuli/scripts/surface-capability-authority.node-test.mjs

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEWED_MOBILE_F2ZMSG_PERMISSIONS } from "./mobile-webview-authority.mjs";

const WALLET_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/// Namespaces a capability entry may name at all. Anything outside this set is
/// a plugin nobody reviewed for these surfaces, so it fails rather than being
/// judged only against the two forbidden prefixes.
const REVIEWED_NAMESPACES = new Set([
  "core",
  "deep-link",
  "opener",
  "f2zmsg",
]);

/// The reviewed contract, per delegated surface.
export const SURFACES = [
  {
    directory: "free2z",
    identifier: "cash.free2z.free2z",
    forbiddenNamespaces: ["zcash", "f2zmsg"],
    forbiddenCrates: ["tauri-plugin-zcash", "tauri-plugin-f2zmsg"],
    requiredCrates: [],
    namedMessagingPermissions: null,
    // The content surface's CSP is the one that must eventually relax to admit
    // embeds and the RealtimeKit SDK (#816/#818). It starts closed, and the
    // relaxation is a reviewed change — but it is NOT asserted here, because a
    // CSP is not what makes this surface safe. Having no privileged command to
    // reach is.
    requireFrameSrcNone: false,
  },
  {
    directory: "e2e2z",
    identifier: "cash.free2z.e2e2z",
    forbiddenNamespaces: ["zcash"],
    forbiddenCrates: ["tauri-plugin-zcash"],
    requiredCrates: ["tauri-plugin-f2zmsg"],
    namedMessagingPermissions: REVIEWED_MOBILE_F2ZMSG_PERMISSIONS,
    // The messaging surface renders no remote content and does hold privileged
    // commands, so it is held to the same rule ZUULI's privileged webview is.
    requireFrameSrcNone: true,
  },
];

function capabilityIdentifiers(capability, file) {
  if (!Array.isArray(capability?.permissions)) {
    throw new Error(`${file}: capability permissions must be an array`);
  }
  return capability.permissions.map((permission) => {
    const identifier =
      typeof permission === "string" ? permission : permission?.identifier;
    if (typeof identifier !== "string" || identifier.length === 0) {
      throw new Error(`${file}: every permission must have an identifier`);
    }
    return identifier;
  });
}

function namespaceOf(identifier) {
  const colon = identifier.lastIndexOf(":");
  return colon < 0 ? identifier : identifier.slice(0, colon);
}

function cspDirective(csp, name) {
  for (const directive of csp.split(";")) {
    const tokens = directive.trim().split(/\s+/).filter(Boolean);
    if (tokens[0] === name) return tokens.slice(1);
  }
  return null;
}

/// Judge one surface from already-read inputs, so the tests can mutate them.
///
/// `capabilities` is a `Map` of relative file path -> parsed capability object,
/// and must be the COMPLETE set the app ships; the live reader enumerates the
/// directory so that stays true.
export function surfaceFailures(surface, { capabilities, manifest, tauriConfig }) {
  const failures = [];
  const label = `wallet/${surface.directory}`;

  if (capabilities.size === 0) {
    failures.push(`${label}: no capability file was read; this check has gone blind`);
  }

  for (const [file, capability] of capabilities) {
    let identifiers;
    try {
      identifiers = capabilityIdentifiers(capability, file);
    } catch (error) {
      failures.push(error.message);
      continue;
    }
    for (const identifier of identifiers) {
      const namespace = namespaceOf(identifier);
      if (surface.forbiddenNamespaces.includes(namespace)) {
        failures.push(
          `${file}: ${label} must never grant ${namespace}:* — found ${identifier}`,
        );
        continue;
      }
      if (!REVIEWED_NAMESPACES.has(namespace)) {
        failures.push(
          `${file}: ${identifier} is outside the reviewed namespaces for ${label} (${[...REVIEWED_NAMESPACES].sort().join(", ")})`,
        );
      }
    }

    if (surface.namedMessagingPermissions) {
      if (identifiers.includes("f2zmsg:default")) {
        failures.push(
          `${file}: ${label} must not take the blanket f2zmsg:default; grant named commands`,
        );
      }
      const messaging = identifiers.filter((identifier) =>
        identifier.startsWith("f2zmsg:"),
      );
      const unreviewed = messaging.filter(
        (identifier) => !surface.namedMessagingPermissions.includes(identifier),
      );
      for (const identifier of unreviewed) {
        failures.push(
          `${file}: ${identifier} is not in the reviewed messaging allowlist`,
        );
      }
      if (new Set(messaging).size !== messaging.length) {
        failures.push(`${file}: messaging permissions must be unique`);
      }
      if (messaging.length === 0) {
        failures.push(`${file}: ${label} grants no messaging command at all`);
      }
    }
  }

  for (const crate of surface.forbiddenCrates) {
    if (manifest.includes(`\n${crate} =`)) {
      failures.push(
        `${label}/src-tauri/Cargo.toml: must not link ${crate}; a capability can only reach a command the process registers`,
      );
    }
  }
  for (const crate of surface.requiredCrates) {
    if (!manifest.includes(`\n${crate} =`)) {
      failures.push(`${label}/src-tauri/Cargo.toml: must link ${crate}`);
    }
  }

  if (tauriConfig?.identifier !== surface.identifier) {
    failures.push(
      `${label}/src-tauri/tauri.conf.json: identifier must be ${surface.identifier}, got ${JSON.stringify(tauriConfig?.identifier)}`,
    );
  }
  const csp = tauriConfig?.app?.security?.csp;
  if (typeof csp !== "string") {
    failures.push(`${label}/src-tauri/tauri.conf.json: packaged CSP must be a string`);
  } else if (surface.requireFrameSrcNone) {
    const frameSources = cspDirective(csp, "frame-src");
    if (!frameSources || frameSources.length !== 1 || frameSources[0] !== "'none'") {
      failures.push(
        `${label}/src-tauri/tauri.conf.json: a privileged native WebView must declare frame-src 'none'`,
      );
    }
  }

  return failures;
}

export function readSurface(surface, walletRoot = WALLET_ROOT) {
  const root = path.join(walletRoot, surface.directory, "src-tauri");
  const capabilityDirectory = path.join(root, "capabilities");
  const capabilities = new Map();
  for (const entry of readdirSync(capabilityDirectory, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = `wallet/${surface.directory}/src-tauri/capabilities/${entry.name}`;
    capabilities.set(
      file,
      JSON.parse(readFileSync(path.join(capabilityDirectory, entry.name), "utf8")),
    );
  }
  return {
    capabilities,
    manifest: readFileSync(path.join(root, "Cargo.toml"), "utf8"),
    tauriConfig: JSON.parse(readFileSync(path.join(root, "tauri.conf.json"), "utf8")),
  };
}

export function assertSurfaceCapabilityAuthority(walletRoot = WALLET_ROOT) {
  const failures = [];
  let capabilityFiles = 0;
  for (const surface of SURFACES) {
    const inputs = readSurface(surface, walletRoot);
    capabilityFiles += inputs.capabilities.size;
    failures.push(...surfaceFailures(surface, inputs));
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
  return { surfaces: SURFACES.length, capabilityFiles };
}

export function main() {
  const { surfaces, capabilityFiles } = assertSurfaceCapabilityAuthority();
  console.log(
    `${surfaces} delegated surface(s) and ${capabilityFiles} capability file(s) hold no ` +
      "wallet authority; free2z grants no zcash:* or f2zmsg:* entry at all.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
