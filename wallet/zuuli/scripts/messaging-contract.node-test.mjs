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

const contract = readFileSync(contractPath, "utf8");
const bridge = readFileSync(bridgePath, "utf8");
const events = readFileSync(eventsPath, "utf8");

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
