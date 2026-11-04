// @cloudflare/realtimekit declares "uuid": "^8.3.2" in every published release,
// and uuid < 11.1.1 carries GHSA-w5hq-g745-h8pq. package.json therefore forces
// realtimekit's uuid to ^11.1.1 with a scoped `overrides` entry  instead
// of renewing a dependency-audit exemption a third time.
//
// That override is only safe while realtimekit uses nothing uuid 11 changed.
// This test pins both halves, against the INSTALLED package rather than a
// remembered review:
//   1. the uuid realtimekit actually resolves is >= 11.1.1 (the override is
//      live -- delete it and this fails before the audit even runs);
//   2. every uuid member each realtimekit bundle reaches -- ESM named imports
//      and CJS `require("uuid").<member>` accesses alike -- is exported, and
//      works, under every resolution condition a consumer can hit (Node
//      require, Node import, and the browser build Vite bundles).
// The bundle scan fails CLOSED: any reference to the "uuid" specifier it does
// not recognise (default import, namespace import, the whole module passed
// around) is an error, so a realtimekit bump that starts using uuid
// differently cannot slip past a parser that quietly matched nothing.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rtkRoot = join(packageRoot, "node_modules/@cloudflare/realtimekit");
const rtkDist = join(rtkRoot, "dist");
const rtkRequire = createRequire(join(rtkDist, "index.cjs.js"));
const uuidPackageJsonPath = rtkRequire.resolve("uuid/package.json");
const uuidRoot = dirname(uuidPackageJsonPath);
const uuidPackage = JSON.parse(readFileSync(uuidPackageJsonPath, "utf8"));

const IDENT = "[A-Za-z_$][\\w$]*";
const UUID_SPECIFIER = /["']uuid["']/g;

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  assert.ok(match, `unparseable uuid version ${version}`);
  return match.slice(1, 4).map(Number);
}

function atLeast(version, floor) {
  const a = parseVersion(version);
  const b = parseVersion(floor);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

// Returns the uuid members one bundle uses, or null when it never names the
// "uuid" specifier at all. Throws on any reference it cannot account for.
function uuidMembersUsedBy(file) {
  const source = readFileSync(file, "utf8");
  const specifierCount = (source.match(UUID_SPECIFIER) ?? []).length;
  if (specifierCount === 0) return null;

  const members = new Set();
  let recognised = 0;

  const esmNamed = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*["']uuid["']`,
    "g",
  );
  for (const [, list] of source.matchAll(esmNamed)) {
    recognised += 1;
    for (const binding of list.split(",")) {
      const imported = binding.trim().split(/\s+as\s+/)[0];
      if (imported) members.add(imported);
    }
  }

  const cjsRequire = new RegExp(
    `(${IDENT})\\s*=\\s*require\\(["']uuid["']\\)`,
    "g",
  );
  for (const [, local] of source.matchAll(cjsRequire)) {
    recognised += 1;
    const escaped = local.replace(/\$/g, "\\$");
    const member = new RegExp(`(?<![\\w$.])${escaped}\\.(${IDENT})`, "g");
    for (const [, name] of source.matchAll(member)) members.add(name);
    // Every other use of the binding must be the declaration itself. A bare
    // use (passed as a value, destructured, shadowed) could reach members
    // this scan cannot see.
    const bare = new RegExp(`(?<![\\w$.])${escaped}(?![\\w$.])`, "g");
    const bareUses = (source.match(bare) ?? []).length;
    assert.equal(
      bareUses,
      1,
      `${file}: the require("uuid") binding ${local} is used ${bareUses - 1} time(s) other than as ${local}.<member>; review the uuid override (#1812) by hand`,
    );
  }

  assert.equal(
    recognised,
    specifierCount,
    `${file}: ${specifierCount} reference(s) to the "uuid" specifier but only ${recognised} recognised as a named ESM import or a require() binding; review the uuid override (#1812) by hand`,
  );
  return members;
}

const bundles = readdirSync(rtkDist)
  .filter((name) => /\.(c|m)?js$/.test(name))
  .map((name) => join(rtkDist, name));

const usage = new Map();
for (const file of bundles) {
  const members = uuidMembersUsedBy(file);
  if (members) usage.set(file, members);
}

// Node's conditional-exports walk (object key order; first match wins), so the
// file under test is the one uuid's own package.json maps that condition set to
// -- not a dist path hard-coded for one uuid major.
function resolveExport(target, conditions) {
  if (typeof target === "string") return target;
  if (target && typeof target === "object") {
    for (const [key, value] of Object.entries(target)) {
      if (key === "default" || conditions.includes(key)) {
        const resolved = resolveExport(value, conditions);
        if (resolved) return resolved;
      }
    }
  }
  return null;
}

function importUuidUnder(conditions) {
  const exportsField = uuidPackage.exports?.["."] ?? uuidPackage.exports;
  const relative = resolveExport(exportsField, conditions);
  assert.ok(
    relative,
    `uuid@${uuidPackage.version} exports nothing for [${conditions}]`,
  );
  return import(pathToFileURL(join(uuidRoot, relative)).href);
}

// Each export condition a consumer can resolve uuid through.
const uuidBuilds = {
  "node require": () => rtkRequire("uuid"),
  "node import": () => importUuidUnder(["node", "import"]),
  "browser import (what Vite bundles)": () =>
    importUuidUnder(["browser", "import", "module"]),
};

test("realtimekit resolves a uuid at or above the GHSA-w5hq-g745-h8pq fix", () => {
  assert.ok(
    atLeast(uuidPackage.version, "11.1.1"),
    `@cloudflare/realtimekit resolves uuid@${uuidPackage.version}; the overrides entry in package.json must force >= 11.1.1 (#1812)`,
  );
});

test("the bundle scan found realtimekit's uuid use (guards against a scan that matches nothing)", () => {
  for (const entry of ["index.es.js", "index.cjs.js"]) {
    const members = usage.get(join(rtkDist, entry));
    assert.ok(
      members && members.size > 0,
      `no uuid use found in dist/${entry}`,
    );
  }
});

for (const [label, load] of Object.entries(uuidBuilds)) {
  test(`every uuid member realtimekit uses exists and works in the ${label} build`, async () => {
    const mod = await load();
    for (const [file, members] of usage) {
      for (const member of members) {
        assert.equal(
          typeof mod[member],
          "function",
          `${file} uses uuid.${member}, which uuid@${uuidPackage.version} (${label}) does not export as a function`,
        );
      }
    }
    const id = mod.v4();
    assert.match(
      id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(mod.validate(id), true);
    assert.equal(mod.validate("not-a-uuid"), false);
  });
}

test("realtimekit's own ESM and CJS entry points load against the overridden uuid", async () => {
  const cjs = rtkRequire(join(rtkDist, "index.cjs.js"));
  assert.equal(typeof (cjs.default ?? cjs), "function");
  // A named import uuid no longer exports would be a link-time SyntaxError here.
  const esm = await import(pathToFileURL(join(rtkDist, "index.es.js")).href);
  assert.equal(typeof esm.default, "function");
});
