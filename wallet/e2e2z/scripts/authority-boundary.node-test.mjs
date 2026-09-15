// Two authorities e2e2z must not hold, checked mechanically.
//
// **Seed authority** — it must not be able to reach the Zcash seed.
// **Dispatch authority** — it must not be able to send an authority-bearing
// intent except through the one reviewed transport (#461, landed as #977).
//
// Both are enforced elsewhere by design and by review. This file is the part
// that does not depend on anyone remembering.
//
// ## 1. Seed authority
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
// ## 2. Dispatch authority
//
// `src/lib/enrollment/transport.ts` ships a fail-closed `IntentTransport` and
// a module-level registry. Two guards keep the default honest and they are
// deliberately independent: the client checks `available` before it samples a
// device key set, and `dispatch` refuses anyway without reading that flag.
// Neither can be defeated by one edit.
//
// But `setIntentTransport` is *exported* — the tests drive the shipping code
// path against a wallet stand-in rather than proving a parallel one works, and
// since #461 a real transport registers through it too. A single call to it
// installs that transport and walks straight past both guards, which is the
// same shape as the objection the module's own comment raises about the
// availability flag, pointed the other way. The registry is not a guard if
// anything in the renderer may write to it.
//
// This rule used to read "only a test may reference it, until #461's transport
// arrives and this rule is deliberately amended along with it." #461 landed —
// verified App Links and Universal Links, #977 — and its transport is here, so
// this is that amendment. `setIntentTransport` may now be *referenced* from
// test files and from exactly ONE production module,
// `src/lib/enrollment/appLinkTransport.ts`, named by exact path rather than by
// a directory pattern.
//
// A **second** production writer still fails, because the property worth
// keeping was never "no transport exists" — it was that the set of modules
// holding dispatch authority is small enough to have been read. One is such a
// set. Widening it means editing the constant below, which is a diff a
// reviewer sees, rather than adding an import nobody notices.
//
// `resetIntentTransport` is unrestricted — it restores the fail-closed default
// and can only ever narrow what this app can do.
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

/** The registry writer. Installing a transport is dispatch authority. */
const TRANSPORT_INSTALLER = "setIntentTransport";

/** Where it is declared. Referencing it here is the declaration, not a call. */
const TRANSPORT_MODULE = "src/lib/enrollment/transport.ts";

/**
 * The one production module permitted to install a transport: #461's App Link
 * surface, the caller `transport.ts` always said this export would one day
 * have. An exact path, deliberately — not `src/lib/enrollment/*`, because the
 * whole point is that a second writer cannot appear without editing this line.
 */
const TRANSPORT_INSTALLER_MODULE = "src/lib/enrollment/appLinkTransport.ts";

/** A file whose references to {@link TRANSPORT_INSTALLER} are permitted. */
function isTestFile(file) {
  return (
    file.endsWith(".test.ts") ||
    file.endsWith(".test.tsx") ||
    file.endsWith(".pw.ts")
  );
}

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
export function authorityFailures({ manifest, capabilities, sources }) {
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
    if (
      file !== TRANSPORT_MODULE &&
      file !== TRANSPORT_INSTALLER_MODULE &&
      !isTestFile(file) &&
      new RegExp(`\\b${TRANSPORT_INSTALLER}\\b`).test(code)
    ) {
      failures.push(
        `${file}: only ${TRANSPORT_INSTALLER_MODULE} and tests may call ${TRANSPORT_INSTALLER}; installing a transport is dispatch authority, and a second writer has not been reviewed as one`,
      );
    }
  }

  // The coverage anchor for the rule above. If the declaring module is renamed
  // or the export is dropped, the rule silently protects nothing — so its
  // subject has to be present for the check to mean anything (#553).
  const transport = sources.get(TRANSPORT_MODULE);
  if (transport !== undefined) {
    if (!new RegExp(`export function ${TRANSPORT_INSTALLER}\\b`).test(transport)) {
      failures.push(
        `${TRANSPORT_MODULE}: must declare ${TRANSPORT_INSTALLER}; a rule about a name nobody declares is a rule about nothing`,
      );
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

test("e2e2z holds no seed authority, and no unreviewed dispatch authority", () => {
  assert.deepEqual(authorityFailures(readTree()), []);
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
    authorityFailures({ manifest: "", capabilities: new Map(), sources: commented }),
    [],
  );

  const executable = new Map([
    ["src/bad.ts", 'export const x = invoke("plugin:zcash|get_seed_phrase");'],
  ]);
  const failures = authorityFailures({
    manifest: "",
    capabilities: new Map(),
    sources: executable,
  });
  assert.equal(failures.length, 2, failures.join("\n"));
});

test("only the sanctioned transport module, or a test, may install a transport", () => {
  // The rule fires on a production module...
  const production = authorityFailures({
    manifest: "",
    capabilities: new Map(),
    sources: new Map([
      ["src/features/messages/index.tsx", "setIntentTransport(appLinkTransport);"],
    ]),
  });
  assert.equal(production.length, 1, production.join("\n"));

  // ...and does not fire on a test, on the module that declares it, or on the
  // one production module #461 licensed.
  assert.deepEqual(
    authorityFailures({
      manifest: "",
      capabilities: new Map(),
      sources: new Map([
        ["src/lib/enrollment/transport.test.ts", "setIntentTransport(stub);"],
        ["tests/whatever.pw.ts", "setIntentTransport(stub);"],
        [
          "src/lib/enrollment/transport.ts",
          "export function setIntentTransport(transport) { active = transport; }",
        ],
        [
          "src/lib/enrollment/appLinkTransport.ts",
          "setIntentTransport(appLinkIntentTransport);",
        ],
      ]),
    }),
    [],
  );

  // Prose that merely names it is not an installation.
  assert.deepEqual(
    authorityFailures({
      manifest: "",
      capabilities: new Map(),
      sources: new Map([
        ["src/lib/messaging/bridge.ts", "// #461's work is to call setIntentTransport.\nexport const x = 1;"],
      ]),
    }),
    [],
  );
});

test("a second production writer is still dispatch authority, and still fails", () => {
  // The amendment above is an exemption for one named file, not the removal of
  // the rule. The obvious next move — a sibling transport beside the sanctioned
  // one, in the same directory, looking exactly as legitimate — is what this
  // pins, because "it is right next to the allowed one" is how the exemption
  // would be read if nobody checked.
  const sibling = authorityFailures({
    manifest: "",
    capabilities: new Map(),
    sources: new Map([
      [
        "src/lib/enrollment/appLinkTransport.ts",
        "setIntentTransport(appLinkIntentTransport);",
      ],
      [
        "src/lib/enrollment/customSchemeTransport.ts",
        "setIntentTransport(customSchemeTransport);",
      ],
    ]),
  });
  assert.equal(sibling.length, 1, sibling.join("\n"));
  assert.match(sibling[0], /customSchemeTransport\.ts/);

  // And it is the path that is exempt, not the filename: the same basename
  // somewhere else is a different module and gets no exemption.
  const elsewhere = authorityFailures({
    manifest: "",
    capabilities: new Map(),
    sources: new Map([
      ["src/lib/messaging/appLinkTransport.ts", "setIntentTransport(t);"],
    ]),
  });
  assert.equal(elsewhere.length, 1, elsewhere.join("\n"));
});

test("the transport rule cannot outlive the export it is about", () => {
  // A rule whose subject has been renamed away protects nothing and says so.
  const orphaned = authorityFailures({
    manifest: "",
    capabilities: new Map(),
    sources: new Map([
      ["src/lib/enrollment/transport.ts", "export function installTransport(t) {}"],
    ]),
  });
  assert.equal(orphaned.length, 1, orphaned.join("\n"));
});

test("the exemption still names a module that exists and still installs", () => {
  // The other half of #553's lesson, applied to the amendment rather than to
  // the rule. An exemption for a path nothing occupies is a hole waiting for
  // whatever is written there next: the rule would go on passing, and the day
  // someone recreates that filename they inherit dispatch authority without a
  // reviewer ever weighing it. So the exemption has to be spent on a real file
  // that really installs, or it is withdrawn.
  const { sources } = readTree();
  const installer = sources.get(TRANSPORT_INSTALLER_MODULE);
  assert.ok(
    installer !== undefined,
    `${TRANSPORT_INSTALLER_MODULE} is exempt from the transport rule but does not exist; delete the exemption or restore the module`,
  );
  assert.match(
    withoutComments(installer),
    new RegExp(`\\b${TRANSPORT_INSTALLER}\\b`),
    `${TRANSPORT_INSTALLER_MODULE} no longer calls ${TRANSPORT_INSTALLER}; an exemption nothing uses should be withdrawn, not left standing`,
  );
});

test("each route is judged, and each fabricated violation is caught", () => {
  const crate = authorityFailures({
    manifest: '[dependencies]\ntauri-plugin-zcash = { path = "../../plugins/tauri-plugin-zcash" }\n',
    capabilities: new Map(),
    sources: new Map(),
  });
  assert.equal(crate.length, 1, crate.join("\n"));

  const capability = authorityFailures({
    manifest: "",
    capabilities: new Map([
      ["capabilities/default.json", { permissions: ["core:default", "zcash:allow-get-balance"] }],
    ]),
    sources: new Map(),
  });
  assert.equal(capability.length, 1, capability.join("\n"));

  const rust = authorityFailures({
    manifest: "",
    capabilities: new Map(),
    sources: new Map([["src-tauri/src/bad.rs", "use tauri_plugin_zcash::ZcashExt as _;"]]),
  });
  assert.equal(rust.length, 1, rust.join("\n"));
});
