// The messaging client compared against CLIENT-CONTRACT.md, not against itself.
//
// `src/lib/messaging/parity.test.ts` pins four artefacts to each other, and all
// four are defined in that module: it proves they agree, and a command added to
// §3 and wired nowhere passes every one of its assertions — including the count,
// which reads 46 === 46 once the document reaches 47.
//
// This reads the document and the bridge and compares sets, so contract growth
// fails here until someone wires it. It lives in scripts/ rather than src/
// because that is where this repository keeps source-scanning tests, and it
// keeps `node:fs` out of the frontend's tsconfig scope.
//
// Since 2026-08-25 it reads a third artefact: `tauri-plugin-f2zmsg`'s command
// registry. §12.3 proposed a separate `scripts/check-client-contract.mjs` for
// that comparison, and a separate file would have been a third place the set is
// written down. The document, the bridge and the plugin are now held to each
// other here, in both directions.
//
// The enrollment trio is the one asymmetry, and it is §2.2's: `f2zmsg_enroll`,
// `f2zmsg_enrollment_status` and `f2zmsg_unenroll` need the wallet seed, so they
// are app-crate commands and are deliberately absent from the plugin. The test
// asserts that absence rather than excusing it.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const contractPath = fileURLToPath(
  new URL("../../../docs/e2ee/CLIENT-CONTRACT.md", import.meta.url),
);
const bridgePath = fileURLToPath(
  new URL("../src/lib/messaging/bridge.ts", import.meta.url),
);
const eventsPath = fileURLToPath(
  new URL("../src/lib/messaging/events.ts", import.meta.url),
);
const registryPath = fileURLToPath(
  new URL(
    "../../plugins/tauri-plugin-f2zmsg/command_registry.rs",
    import.meta.url,
  ),
);

const contract = readFileSync(contractPath, "utf8");
const bridge = readFileSync(bridgePath, "utf8");
const events = readFileSync(eventsPath, "utf8");
const registry = readFileSync(registryPath, "utf8");

/// §2.2: these three need the wallet seed, so they live in
/// `wallet/zuuli/src-tauri/src/messaging.rs` and are invoked with no `plugin:`
/// prefix. The plugin must not register them.
const APP_CRATE_COMMANDS = new Set([
  "f2zmsg_enroll",
  "f2zmsg_enrollment_status",
  "f2zmsg_unenroll",
]);

/** §3's command tables are `| \`name\` | args | Returns |`. */
function declaredCommands() {
  const start = contract.indexOf("## 3. The command surface");
  const end = contract.indexOf("## 4. The TypeScript contract");
  assert.ok(start >= 0 && end > start, "§3 not found in CLIENT-CONTRACT.md");

  const names = new Set();
  for (const line of contract.slice(start, end).split("\n")) {
    const cell = /^\|\s*`([a-z][a-z_0-9]*)`\s*\|/.exec(line);
    if (cell) names.add(cell[1]);
  }
  return names;
}

/** §5.1's table is `| \`f2zmsg://name\` | payload | when |`. */
function declaredEvents() {
  const names = new Set();
  for (const line of contract.split("\n")) {
    const cell = /^\|\s*`(f2zmsg:\/\/[a-z-]+)`\s*\|/.exec(line);
    if (cell) names.add(cell[1]);
  }
  return names;
}

/** The wire names in `WIRE_COMMANDS`, which is the bridge's one population. */
function implementedCommands() {
  const block = /export const WIRE_COMMANDS = \{([\s\S]*?)\n\} as const;/.exec(
    bridge,
  );
  assert.ok(block, "WIRE_COMMANDS literal not found in bridge.ts");

  const names = new Set();
  for (const [, wire] of block[1].matchAll(/^\s*\w+:\s*"([a-z_0-9]+)",$/gm)) {
    names.add(wire);
  }
  return names;
}

function implementedEvents() {
  const block = /export const EVENTS = \{([\s\S]*?)\n\} as const;/.exec(events);
  assert.ok(block, "EVENTS literal not found in events.ts");

  const names = new Set();
  for (const [, name] of block[1].matchAll(/"(f2zmsg:\/\/[a-z-]+)":/g)) {
    names.add(name);
  }
  return names;
}

/** The idents inside `with_f2zmsg_commands!`, which is the plugin's one population. */
function registeredCommands() {
  const block = /\$callback!\s*\{([\s\S]*?)\n\s*\}/.exec(registry);
  assert.ok(block, "the command registry macro body was not found");

  const names = new Set();
  for (const [, name] of block[1].matchAll(/^\s*([a-z0-9_]+),$/gm)) {
    names.add(name);
  }
  return names;
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}

test("the contract and the bridge are the documents this test thinks they are", () => {
  // Without these, a moved file or a renamed heading makes every comparison
  // below vacuous instead of failing.
  assert.match(contract, /# free2z E2EE — Client contract/);
  assert.ok(declaredCommands().size > 0, "no commands parsed from §3");
  assert.ok(declaredEvents().size > 0, "no events parsed from §5.1");
  assert.ok(implementedCommands().size > 0, "no commands parsed from bridge.ts");
  assert.ok(implementedEvents().size > 0, "no events parsed from events.ts");
  assert.ok(
    registeredCommands().size > 0,
    "no commands parsed from the plugin's command registry",
  );
});

test("the bridge implements exactly the commands §3 declares", () => {
  const spec = declaredCommands();
  const impl = implementedCommands();

  assert.deepEqual(
    { missing: difference(spec, impl), extra: difference(impl, spec) },
    { missing: [], extra: [] },
  );
});

test("events.ts declares exactly the events §5.1 does", () => {
  const spec = declaredEvents();
  const impl = implementedEvents();

  assert.deepEqual(
    { missing: difference(spec, impl), extra: difference(impl, spec) },
    { missing: [], extra: [] },
  );
});

test("the plugin registers exactly the commands §3 declares, minus the app-crate trio", () => {
  const spec = new Set(
    [...declaredCommands()].filter((name) => !APP_CRATE_COMMANDS.has(name)),
  );
  const impl = registeredCommands();

  assert.deepEqual(
    { missing: difference(spec, impl), extra: difference(impl, spec) },
    { missing: [], extra: [] },
  );
});

test("the plugin does not register a command that needs the wallet seed", () => {
  // §2.2. If one of these ever appears in the plugin, the mnemonic has a route
  // into the webview's JavaScript heap and the whole reason enrollment lives in
  // the app crate is gone.
  const registered = registeredCommands();
  assert.deepEqual(
    [...APP_CRATE_COMMANDS].filter((name) => registered.has(name)),
    [],
  );
});

test("the bridge and the plugin agree, so neither can drift alone", () => {
  // The document is the source of truth and both are compared to it above.
  // This is the diagonal: it fails with a clearer message when only one of the
  // two moved, which is the likeliest way this breaks.
  const bridge = new Set(
    [...implementedCommands()].filter((name) => !APP_CRATE_COMMANDS.has(name)),
  );
  const plugin = registeredCommands();

  assert.deepEqual(
    { onlyInBridge: difference(bridge, plugin), onlyInPlugin: difference(plugin, bridge) },
    { onlyInBridge: [], onlyInPlugin: [] },
  );
});
