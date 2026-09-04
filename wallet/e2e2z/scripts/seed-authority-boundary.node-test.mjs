// e2e2z reaches no seed, and this is the check that says so mechanically.
//
// #904's premise is a hard one: this app holds device keys and a
// `DeviceCredential` and **never** anything seed-derived
// (`docs/e2ee/ARCHITECTURE.md` §4.2). Every other guard in this tree is about
// what happens when the boundary holds. This one is about the boundary itself.
//
// Three routes exist by which seed authority could arrive, and all three are
// checked, because closing two of them is closing none:
//
//   1. **A crate.** Linking `tauri-plugin-zcash` puts the seed in this
//      process's managed state. `src-tauri/src/lib.rs` asserts this too; it is
//      repeated here so that a check written in the language of the manifest
//      exists even if the crate's own test is deleted.
//   2. **A capability.** A `zcash:*` grant would let the webview call the
//      wallet plugin directly. `wallet/zuuli/scripts/surface-capability-authority.mjs`
//      is the repository-wide version; this is the app-local one, and it runs
//      in this app's own `npm test` rather than only in the ZUULI lane.
//   3. **An invoke.** A frontend string is all it takes to call a command, and
//      neither of the checks above sees one. `CLIENT-CONTRACT.md` §2.2 names
//      the two commands that can reach the phrase — `get_seed_phrase` and
//      `get_backup_seed_phrase` — so they are named here.
//
// Not a substitute for reading the code, and it does not pretend to be: an
// equivalent route under another name would pass. It is the check that catches
// the way seed authority actually arrives, which is somebody adding the
// obvious dependency or the obvious permission because a feature needed it.
//
// Structured as a pure judge plus a live reader, so that the judge can be
// handed a fabricated violation. A boundary scanner that has silently stopped
// finding files reports success forever — #553's lesson — so the last test
// asserts the reader saw something.

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

/** The wallet plugin, by the name a manifest would name it. */
const FORBIDDEN_CRATE = "tauri-plugin-zcash";

/** The two commands that can reach the recovery phrase (§2.2). */
const SEED_COMMANDS = ["get_seed_phrase", "get_backup_seed_phrase"];

/** The IPC prefix of the wallet plugin, as a frontend would write it. */
const WALLET_PLUGIN_PREFIX = "plugin:zcash|";

/**
 * Strip `//` line comments and `/* *\/` block comments.
 *
 * Prose in this tree discusses the seed at length — it has to, since the whole
 * design is about not having one — so a scan over raw text would either be
 * inert or would forbid explaining itself. Only executable text is judged.
 */
export function withoutComments(source) {
  let out = "";
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    out += source[index];
    index += 1;
  }
  return out;
}

/** Judge already-read inputs, so a fabricated violation can be handed in. */
export function seedAuthorityFailures({ manifest, capabilities, sources }) {
  const failures = [];

  if (new RegExp(`(^|\\n)\\s*${FORBIDDEN_CRATE}\\s*=`).test(manifest)) {
    failures.push(
      `src-tauri/Cargo.toml: e2e2z must not link ${FORBIDDEN_CRATE}; ongoing messaging never needs the seed`,
    );
  }

  for (const [file, capability] of capabilities) {
    for (const permission of capability.permissions ?? []) {
      const identifier =
        typeof permission === "string" ? permission : permission?.identifier;
      if (typeof identifier === "string" && identifier.startsWith("zcash:")) {
        failures.push(`${file}: e2e2z must grant no zcash:* permission (${identifier})`);
      }
    }
  }

  for (const [file, source] of sources) {
    const code = withoutComments(source);
    if (code.includes(WALLET_PLUGIN_PREFIX)) {
      failures.push(`${file}: e2e2z must not address the wallet plugin (${WALLET_PLUGIN_PREFIX})`);
    }
    for (const command of SEED_COMMANDS) {
      if (code.includes(command)) {
        failures.push(`${file}: e2e2z must not name the seed command ${command}`);
      }
    }
    if (/\btauri_plugin_zcash\b/.test(code) || /\bZcashExt\b/.test(code)) {
      failures.push(`${file}: e2e2z must not use the wallet plugin's Rust API`);
    }
  }

  return failures;
}

function filesUnder(directory, extensions) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === "target" || entry === "dist") continue;
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (extensions.some((extension) => entry.endsWith(extension))) found.push(full);
    }
  };
  walk(directory);
  return found;
}

function readTree() {
  const manifest = readFileSync(path.join(appRoot, "src-tauri/Cargo.toml"), "utf8");

  const capabilityDirectory = path.join(appRoot, "src-tauri/capabilities");
  const capabilities = new Map();
  for (const file of filesUnder(capabilityDirectory, [".json"])) {
    capabilities.set(
      path.relative(appRoot, file),
      JSON.parse(readFileSync(file, "utf8")),
    );
  }

  const sources = new Map();
  for (const directory of ["src", "src-tauri/src", "tests"]) {
    for (const file of filesUnder(path.join(appRoot, directory), [
      ".ts",
      ".tsx",
      ".rs",
    ])) {
      sources.set(path.relative(appRoot, file), readFileSync(file, "utf8"));
    }
  }

  return { manifest, capabilities, sources };
}

test("e2e2z holds no route to the wallet seed", () => {
  assert.deepEqual(seedAuthorityFailures(readTree()), []);
});

test("the scan is not blind", () => {
  const tree = readTree();
  assert.ok(tree.manifest.length > 0, "the Tauri manifest must be read");
  assert.ok(tree.capabilities.size > 0, "at least one capability file must be read");
  assert.ok(tree.sources.size > 20, "the source tree must be read");
});

test("prose about the seed is not a violation, and code is", () => {
  // The two halves of the comment rule, together. Without the first this file
  // could not explain itself; without the second it would be decorative.
  const commented = new Map([
    ["src/prose.ts", '// this app never calls get_seed_phrase\nexport const x = 1;'],
  ]);
  assert.deepEqual(
    seedAuthorityFailures({ manifest: "", capabilities: new Map(), sources: commented }),
    [],
  );

  const executable = new Map([
    ["src/bad.ts", 'export const x = invoke("plugin:zcash|get_seed_phrase");'],
  ]);
  const failures = seedAuthorityFailures({
    manifest: "",
    capabilities: new Map(),
    sources: executable,
  });
  assert.equal(failures.length, 2, failures.join("\n"));
});

test("each route is judged, and each fabricated violation is caught", () => {
  const crate = seedAuthorityFailures({
    manifest: '[dependencies]\ntauri-plugin-zcash = { path = "../../plugins/tauri-plugin-zcash" }\n',
    capabilities: new Map(),
    sources: new Map(),
  });
  assert.equal(crate.length, 1, crate.join("\n"));

  const capability = seedAuthorityFailures({
    manifest: "",
    capabilities: new Map([
      ["capabilities/default.json", { permissions: ["core:default", "zcash:allow-get-balance"] }],
    ]),
    sources: new Map(),
  });
  assert.equal(capability.length, 1, capability.join("\n"));

  const rust = seedAuthorityFailures({
    manifest: "",
    capabilities: new Map(),
    sources: new Map([["src-tauri/src/bad.rs", "use tauri_plugin_zcash::ZcashExt as _;"]]),
  });
  assert.equal(rust.length, 1, rust.join("\n"));
});
