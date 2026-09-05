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

/// Namespaces every delegated surface may name. Anything outside a surface's
/// own set is a plugin nobody reviewed for it, so it fails rather than being
/// judged only against the forbidden prefixes.
///
/// The set is PER SURFACE, not global: what a content app may reach and what a
/// messaging app may reach are different questions with different answers, and
/// a single shared set silently answers both at once the moment either changes.
const BASE_NAMESPACES = ["core", "deep-link", "opener"];

/// The reviewed contract, per delegated surface.
export const SURFACES = [
  {
    directory: "free2z",
    identifier: "cash.free2z.free2z",
    forbiddenNamespaces: ["zcash", "f2zmsg"],
    forbiddenCrates: ["tauri-plugin-zcash", "tauri-plugin-f2zmsg"],
    requiredCrates: [],
    namedMessagingPermissions: null,
    // `http` IS reviewed for this surface, and this comment is the record of
    // that review (#918).
    //
    // WHAT IT IS. `tauri-plugin-http` registers `plugin:http|fetch`: a native
    // HTTP client that is not subject to browser CORS. The frontend needs it
    // because the free2z backend whitelists a handful of web origins and
    // `tauri://localhost` is not one of them, so in a packaged build EVERY API
    // request and every first-party image download goes through it
    // (`src/lib/api/http.ts`, `src/components/common/RemoteMedia.tsx`).
    //
    // WHY IT IS NOT THE SAME KIND OF THING AS `zcash`/`f2zmsg`. Those export
    // authority the process holds locally — a seed, device keys — so a caller
    // reaching them gains something it could not otherwise have. This one
    // exports no local authority at all; its entire reach is the URL scope
    // below. A hostile subframe that reaches it can talk to free2z's own API,
    // which is a thing it can already do from a page it controls.
    //
    // WHAT THE REVIEW ACTUALLY DECIDED, and what `scopedNamespaces` enforces:
    // an `http` grant on this surface must be a SCOPED object with a non-empty
    // allow list, every entry `https://<host>/*`, and every host already
    // admitted by this app's own `connect-src`. A bare `"http:default"` fails —
    // which matters even though an empty allow list denies every URL, because
    // "the identifier alone is inert" is a property of today's plugin, and the
    // reviewable statement is which origins this client may reach.
    reviewedNamespaces: [...BASE_NAMESPACES, "http"],
    scopedNamespaces: ["http"],
    // The content surface's CSP is the one that must eventually relax to admit
    // embeds and the RealtimeKit SDK (#816/#818). It starts closed, and the
    // relaxation is a reviewed change — but it is NOT asserted here, because a
    // CSP is not what makes this surface safe. Having no privileged command to
    // reach is.
    requireFrameSrcNone: false,
    // The load-bearing one. This process renders third-party markup, remote
    // media and a livestream SDK, and #367 means a remote subframe resolves as
    // the trusted main window — so the only durable answer is that there is no
    // app command in it to reach. A capability file cannot express that: it
    // scopes by window label, and there is one label. The crate must register
    // no `invoke_handler`, and the frontend must not even import the function
    // that would call one.
    registersCommands: false,
  },
  {
    directory: "e2e2z",
    identifier: "cash.free2z.e2e2z",
    forbiddenNamespaces: ["zcash"],
    forbiddenCrates: ["tauri-plugin-zcash"],
    requiredCrates: ["tauri-plugin-f2zmsg"],
    namedMessagingPermissions: REVIEWED_MOBILE_F2ZMSG_PERMISSIONS,
    reviewedNamespaces: [...BASE_NAMESPACES, "f2zmsg"],
    scopedNamespaces: [],
    // The messaging surface renders no remote content and does hold privileged
    // commands, so it is held to the same rule ZUULI's privileged webview is.
    requireFrameSrcNone: true,
    // It registers `e2e2z_device_credential_keys`, and its own crate test holds
    // the handler to that one command.
    registersCommands: true,
  },
];

function capabilityPermissions(capability, file) {
  if (!Array.isArray(capability?.permissions)) {
    throw new Error(`${file}: capability permissions must be an array`);
  }
  return capability.permissions.map((permission) => {
    const identifier =
      typeof permission === "string" ? permission : permission?.identifier;
    if (typeof identifier !== "string" || identifier.length === 0) {
      throw new Error(`${file}: every permission must have an identifier`);
    }
    return { identifier, entry: permission };
  });
}

/// A scoped URL entry: exactly `https://<host>/*`, where `<host>` may lead with
/// one `*.` label. Anything else — a scheme wildcard, a bare `*` host, a port,
/// userinfo, a query, a fixed path — is refused rather than reasoned about,
/// because the reviewable statement is "this client may reach these origins".
const SCOPED_URL = /^https:\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/\*$/;

/// Hold a scoped namespace to a non-empty allow list of origins the app's own
/// `connect-src` already admits. The CSP is not what makes the surface safe,
/// but it IS the reviewed statement of where this app talks, and a native
/// client that can reach further than the document can is a second, unreviewed
/// network boundary.
function scopedEntryFailures(surface, file, identifier, entry, connectSources) {
  const label = `wallet/${surface.directory}`;
  const failures = [];
  if (typeof entry === "string") {
    failures.push(
      `${file}: ${identifier} must be a scoped object with an allow list, not a bare string; ` +
        `an unscoped ${namespaceOf(identifier)} grant on ${label} is a grant nobody reviewed`,
    );
    return failures;
  }
  const allow = entry?.allow;
  if (!Array.isArray(allow) || allow.length === 0) {
    failures.push(`${file}: ${identifier} must carry a non-empty allow list`);
    return failures;
  }
  for (const item of allow) {
    const url = typeof item === "string" ? item : item?.url;
    if (typeof url !== "string") {
      failures.push(`${file}: ${identifier} allow entries must each name a url`);
      continue;
    }
    const match = SCOPED_URL.exec(url);
    if (!match) {
      failures.push(
        `${file}: ${identifier} may only allow \`https://<host>/*\` — found ${url}`,
      );
      continue;
    }
    const origin = `https://${match[1] ?? ""}${match[2]}`;
    if (connectSources && !connectSources.includes(origin)) {
      failures.push(
        `${file}: ${identifier} allows ${url}, which ${label}'s connect-src does not admit; ` +
          "the native client must not reach further than the document",
      );
    }
  }
  return failures;
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
export function surfaceFailures(
  surface,
  { capabilities, manifest, tauriConfig, packageJson, entrypoint, sources },
) {
  const failures = [];
  const label = `wallet/${surface.directory}`;
  const csp = tauriConfig?.app?.security?.csp;
  const connectSources =
    typeof csp === "string" ? cspDirective(csp, "connect-src") : null;

  if (capabilities.size === 0) {
    failures.push(`${label}: no capability file was read; this check has gone blind`);
  }

  for (const [file, capability] of capabilities) {
    let permissions;
    try {
      permissions = capabilityPermissions(capability, file);
    } catch (error) {
      failures.push(error.message);
      continue;
    }
    const identifiers = permissions.map((permission) => permission.identifier);
    for (const { identifier, entry } of permissions) {
      const namespace = namespaceOf(identifier);
      if (surface.forbiddenNamespaces.includes(namespace)) {
        failures.push(
          `${file}: ${label} must never grant ${namespace}:* — found ${identifier}`,
        );
        continue;
      }
      if (!surface.reviewedNamespaces.includes(namespace)) {
        failures.push(
          `${file}: ${identifier} is outside the reviewed namespaces for ${label} (${[...surface.reviewedNamespaces].sort().join(", ")})`,
        );
        continue;
      }
      if (surface.scopedNamespaces.includes(namespace)) {
        failures.push(
          ...scopedEntryFailures(surface, file, identifier, entry, connectSources),
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

  failures.push(
    ...nativeContractFailures(surface, {
      manifest,
      tauriConfig,
      packageJson,
      entrypoint,
      sources,
    }),
  );

  return failures;
}

// ---------------------------------------------------------------------------
// The JS -> native contract.
//
// #918 is what happens when nobody checks it. #912 ported three frontend paths
// that branch on `isTauri() && !DEV` and never wrote the Rust side they call
// into, and no gate could see it: vitest, Playwright and `npm run build` all
// run where `isTauri()` is false or DEV is true — exactly the branch NOT taken
// — and `cargo check` compiles a backend nobody asked whether the frontend
// expects commands from it. So the two halves are compared here, off the files.
// ---------------------------------------------------------------------------

/// `@tauri-apps/plugin-deep-link` -> `tauri_plugin_deep_link`.
function crateModule(plugin) {
  return `tauri_plugin_${plugin.replaceAll("-", "_")}`;
}

/// The `tauri::Builder` chain itself, so a doc comment or a crate test that
/// mentions `invoke_handler` is not mistaken for one.
function builderBody(entrypoint) {
  return entrypoint.split("pub fn run() {")[1]?.split("\n}")[0] ?? "";
}

/// Command names the crate registers, read out of `generate_handler![...]`.
/// An absent `invoke_handler` is an empty set, which is the point for free2z.
function registeredCommands(entrypoint) {
  const list = builderBody(entrypoint)
    .split("invoke_handler(tauri::generate_handler![")
    .slice(1)
    .flatMap((rest) => rest.split("])")[0].split(","));
  return new Set(
    list
      .map((name) => name.trim().split("::").pop())
      .filter((name) => /^[a-z_][a-z0-9_]*$/.test(name)),
  );
}

/// Every `invoke("literal")` in production sources. A command built from a
/// variable is out of reach of a text check and is left to the surface's own
/// contract tests; a literal is the shape that actually drifted (#918).
const INVOKE_LITERAL = /\binvoke\s*(?:<[^<>]*>)?\s*\(\s*["'`]([^"'`\n]+)["'`]/g;

/// Any private-use URI belonging to one of the three apps in the split.
const APP_SCHEME_URI = /\b(cash\.free2z\.[a-z0-9]+):\/\/([a-z0-9.-]*)(\/[A-Za-z0-9/_%-]*)?/g;

function deepLinkRoutes(tauriConfig) {
  const routes = new Set();
  const mobile = tauriConfig?.plugins?.["deep-link"]?.mobile;
  if (!Array.isArray(mobile)) return routes;
  for (const entry of mobile) {
    const schemes = Array.isArray(entry?.scheme) ? entry.scheme : [entry?.scheme];
    const paths = Array.isArray(entry?.path) ? entry.path : [entry?.path];
    for (const scheme of schemes) {
      for (const routePath of paths) {
        if (typeof scheme !== "string" || typeof entry?.host !== "string") continue;
        routes.add(`${scheme}://${entry.host}${routePath ?? ""}`);
      }
    }
  }
  return routes;
}

export function nativeContractFailures(
  surface,
  { manifest, tauriConfig, packageJson, entrypoint, sources },
) {
  const failures = [];
  const label = `wallet/${surface.directory}`;
  const dependencies = packageJson?.dependencies ?? {};

  if (!sources || sources.size === 0) {
    failures.push(
      `${label}/src: no production source was read; the JS -> native contract check has gone blind`,
    );
  }
  if (!entrypoint) {
    failures.push(`${label}/src-tauri/src/lib.rs: was not read; this check has gone blind`);
    return failures;
  }

  // 1. A JS plugin package with no crate is a command that does not exist.
  //    `@tauri-apps/plugin-http` sat in free2z's package.json for two releases
  //    with no `tauri-plugin-http` behind it, so every API request in a
  //    packaged build invoked `plugin:http|fetch` into an empty handler.
  for (const dependency of Object.keys(dependencies)) {
    const plugin = dependency.startsWith("@tauri-apps/plugin-")
      ? dependency.slice("@tauri-apps/plugin-".length)
      : null;
    if (!plugin) continue;
    if (!manifest.includes(`\ntauri-plugin-${plugin} =`)) {
      failures.push(
        `${label}/src-tauri/Cargo.toml: package.json depends on ${dependency} but the crate ` +
          `tauri-plugin-${plugin} is not linked; its commands do not exist in this binary`,
      );
      continue;
    }
    if (!builderBody(entrypoint).includes(`${crateModule(plugin)}::init()`)) {
      failures.push(
        `${label}/src-tauri/src/lib.rs: tauri-plugin-${plugin} is linked but never initialized; ` +
          "a linked plugin registers nothing until .plugin(...) runs",
      );
    }
  }

  // 2. No production source may invoke a command this binary does not register.
  const commands = registeredCommands(entrypoint);
  for (const [file, source] of sources) {
    for (const [, command] of source.matchAll(INVOKE_LITERAL)) {
      if (command.startsWith("plugin:")) {
        const plugin = command.slice("plugin:".length).split("|")[0];
        if (!manifest.includes(`\ntauri-plugin-${plugin} =`)) {
          failures.push(
            `${file}: invokes ${command}, but ${label} does not link tauri-plugin-${plugin}`,
          );
        }
        continue;
      }
      if (!commands.has(command)) {
        failures.push(
          `${file}: invokes "${command}", which ${label}'s invoke handler does not register`,
        );
      }
    }
  }

  // 3. A surface that registers no command must not hold the function that
  //    would call one. This is the stronger form of rule 2 and the one that
  //    actually fires: it does not depend on a command name being spelled as a
  //    literal, and it makes "there is nothing to reach" mechanical rather than
  //    a claim in a comment.
  if (!surface.registersCommands) {
    if (builderBody(entrypoint).includes("invoke_handler")) {
      failures.push(
        `${label}/src-tauri/src/lib.rs: must register no invoke_handler; ` +
          "#367 means a remote subframe in this process resolves as the trusted main window",
      );
    }
    for (const [file, source] of sources) {
      if (/["']@tauri-apps\/api\/core["']/.test(source)) {
        failures.push(
          `${file}: imports @tauri-apps/api/core, but ${label} registers no command to invoke`,
        );
      }
    }
  }

  // 4. A private-use URI in this tree must be THIS app's, and must be a route
  //    this app's manifest actually registers. Getting this wrong is the worst
  //    of #918's three defects: the other two fail closed and loudly, while a
  //    `cash.free2z.zuuli://` URI in the content app hands an OAuth code or a
  //    Stripe claim code to the wallet-authority app on any device with both
  //    installed.
  const routes = deepLinkRoutes(tauriConfig);
  for (const [file, source] of sources) {
    for (const [, scheme, host, routePath] of source.matchAll(APP_SCHEME_URI)) {
      if (scheme !== surface.identifier) {
        failures.push(
          `${file}: names ${scheme}://${host}${routePath ?? ""}, which belongs to another app; ` +
            `${label} must use ${surface.identifier}://`,
        );
        continue;
      }
      const route = `${scheme}://${host}${routePath ?? ""}`;
      if (!routes.has(route)) {
        failures.push(
          `${file}: ${route} is not registered in ${label}/src-tauri/tauri.conf.json ` +
            "(plugins.deep-link), so the OS would never deliver it here",
        );
      }
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
  const project = path.join(walletRoot, surface.directory);
  return {
    capabilities,
    manifest: readFileSync(path.join(root, "Cargo.toml"), "utf8"),
    tauriConfig: JSON.parse(readFileSync(path.join(root, "tauri.conf.json"), "utf8")),
    packageJson: JSON.parse(readFileSync(path.join(project, "package.json"), "utf8")),
    entrypoint: readFileSync(path.join(root, "src", "lib.rs"), "utf8"),
    sources: readProductionSources(surface, project),
  };
}

/// Production TypeScript, keyed by repository-relative path.
///
/// Tests are excluded on purpose: a test that asserts the wallet app's URI is
/// refused has to spell that URI, and a test that proves the invoke-parity rule
/// fires has to spell a command that does not exist.
function readProductionSources(surface, project) {
  const sources = new Map();
  const root = path.join(project, "src");
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name)) {
        continue;
      }
      const relative = path.relative(project, absolute).split(path.sep).join("/");
      sources.set(
        `wallet/${surface.directory}/${relative}`,
        readFileSync(absolute, "utf8"),
      );
    }
  };
  walk(root);
  if (sources.size === 0) {
    throw new Error(
      `wallet/${surface.directory}/src: no production source was read; this check has gone blind`,
    );
  }
  return sources;
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
