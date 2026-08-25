#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(root, "wallet/plugins/tauri-plugin-zcash");

function unique(values, label) {
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  if (duplicates.length) {
    throw new Error(`${label} contains duplicates: ${[...new Set(duplicates)].join(", ")}`);
  }
  return [...values].sort();
}

function assertSameSet(expected, actual, label) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((value) => !actualSet.has(value));
  const extra = actual.filter((value) => !expectedSet.has(value));
  if (missing.length || extra.length) {
    throw new Error(
      `${label} drifted` +
        `${missing.length ? `; missing: ${missing.join(", ")}` : ""}` +
        `${extra.length ? `; extra: ${extra.join(", ")}` : ""}`,
    );
  }
}

function collectConsts(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectConsts(item, output);
  } else if (value && typeof value === "object") {
    if (typeof value.const === "string") output.push(value.const);
    for (const item of Object.values(value)) collectConsts(item, output);
  }
  return output;
}

function assertIdentical(entries, label) {
  const [first, ...rest] = entries;
  const different = rest.filter((entry) => !entry.contents.equals(first.contents));
  if (different.length) {
    throw new Error(
      `${label} differ: ${[first, ...different].map((entry) => entry.name).join(", ")}`,
    );
  }
}

function schemaNamesFromTrackedPaths(listing, schemaDir) {
  const prefix = `${schemaDir}/`;
  const names = listing
    .split("\n")
    .filter(Boolean)
    .map((entry) => {
      if (!entry.startsWith(prefix) || !entry.endsWith("-schema.json")) {
        throw new Error(`unexpected tracked Zuuallet schema path: ${entry}`);
      }
      return entry.slice(prefix.length);
    });
  if (!names.length) throw new Error("no tracked Zuuallet target schemas found");
  return unique(names, "tracked Zuuallet target schemas");
}

function expectFailure(fn, pattern) {
  try {
    fn();
  } catch (error) {
    if (pattern.test(String(error))) return;
    throw error;
  }
  throw new Error(`negative control did not fail: ${pattern}`);
}

function commandRegistryNames(source) {
  const callback = source.match(/\$callback!\s*\{([\s\S]*?)\n\s*\}/);
  if (!callback) throw new Error("could not find shared command registry");
  const commands = [...callback[1].matchAll(/^\s*([a-z0-9_]+),\s*$/gm)].map(
    (match) => match[1],
  );
  const residue = callback[1].replace(/^\s*[a-z0-9_]+,\s*$/gm, "").trim();
  if (residue) throw new Error(`unrecognized shared command registry syntax: ${residue}`);
  if (!commands.length) throw new Error("shared command registry is empty");
  return unique(commands, "shared command registry");
}

function selfTest() {
  expectFailure(
    () => assertSameSet(["one", "two"], ["one", "two", "stale"], "permissions"),
    /extra: stale/,
  );
  expectFailure(
    () => assertSameSet(["one", "two"], ["one"], "permissions"),
    /missing: two/,
  );
  expectFailure(() => unique(["one", "one"], "commands"), /duplicates: one/);
  expectFailure(
    () => commandRegistryNames("$callback! {\n one,\n one,\n }"),
    /duplicates: one/,
  );
  expectFailure(
    () => commandRegistryNames("$callback! {\n one => hidden,\n }"),
    /unrecognized shared command registry syntax/,
  );
  expectFailure(
    () =>
      assertIdentical(
        [
          { name: "linux", contents: Buffer.from("current") },
          { name: "macOS", contents: Buffer.from("stale") },
        ],
        "target schemas",
      ),
    /target schemas differ: linux, macOS/,
  );
  const discoveredSchemas = schemaNamesFromTrackedPaths(
    "wallet/zuuallet/src-tauri/gen/schemas/linux-schema.json\n" +
      "wallet/zuuallet/src-tauri/gen/schemas/windows-schema.json\n",
    "wallet/zuuallet/src-tauri/gen/schemas",
  );
  assertSameSet(
    ["linux-schema.json", "windows-schema.json"],
    discoveredSchemas,
    "dynamic target schema discovery",
  );
  expectFailure(
    () => schemaNamesFromTrackedPaths("", "wallet/zuuallet/src-tauri/gen/schemas"),
    /no tracked Zuuallet target schemas/,
  );
  console.log("Zcash permission parity negative controls passed.");
}

if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const registrySource = fs.readFileSync(
  path.join(plugin, "command_registry.rs"),
  "utf8",
);
const commands = commandRegistryNames(registrySource);

const buildSource = fs.readFileSync(path.join(plugin, "build.rs"), "utf8");
if (
  !buildSource.includes('include!("command_registry.rs");') ||
  !buildSource.includes("with_zcash_commands!(command_names)")
) {
  throw new Error("build.rs does not consume the shared command registry");
}
const libSource = fs.readFileSync(path.join(plugin, "src/lib.rs"), "utf8");
if (
  !libSource.includes('include!("../command_registry.rs");') ||
  !libSource.includes(".invoke_handler(with_zcash_commands!(command_handler))")
) {
  throw new Error("runtime invoke handler does not consume the shared command registry");
}

const commandDir = path.join(plugin, "permissions/autogenerated/commands");
const generatedCommands = unique(
  fs
    .readdirSync(commandDir)
    .filter((name) => name.endsWith(".toml"))
    .map((name) => name.slice(0, -5)),
  "generated command permissions",
);
assertSameSet(commands, generatedCommands, "registered and generated commands");

const permissionIds = [];
for (const command of commands) {
  const source = fs.readFileSync(path.join(commandDir, `${command}.toml`), "utf8");
  const kebab = command.replaceAll("_", "-");
  const expectedIds = [`allow-${kebab}`, `deny-${kebab}`];
  const actualIds = [...source.matchAll(/^identifier = "([^"]+)"$/gm)].map(
    (match) => match[1],
  );
  assertSameSet(expectedIds, actualIds, `${command}.toml identifiers`);
  for (const mode of ["allow", "deny"]) {
    if (!source.includes(`commands.${mode} = ["${command}"]`)) {
      throw new Error(`${command}.toml does not ${mode} exactly ${command}`);
    }
  }
  permissionIds.push(...expectedIds);
}

const permissionSchema = JSON.parse(
  fs.readFileSync(path.join(plugin, "permissions/schemas/schema.json"), "utf8"),
);
const schemaIds = unique(
  collectConsts(permissionSchema).filter((value) => /^(allow|deny)-/.test(value)),
  "permission schema identifiers",
);
assertSameSet(permissionIds.sort(), schemaIds, "command TOMLs and permission schema");

const reference = fs.readFileSync(
  path.join(plugin, "permissions/autogenerated/reference.md"),
  "utf8",
);
const referenceIds = unique(
  [...reference.matchAll(/`zcash:((?:allow|deny)-[a-z0-9-]+)`/g)].map(
    (match) => match[1],
  ),
  "permission reference identifiers",
);
assertSameSet(permissionIds, referenceIds, "command TOMLs and permission reference");

const appSchemaDir = path.join(root, "wallet/zuuallet/src-tauri/gen/schemas");
const appSchemaRelativeDir = "wallet/zuuallet/src-tauri/gen/schemas";
const appSchemaNames = schemaNamesFromTrackedPaths(
  execFileSync("git", ["ls-files", "--", `${appSchemaRelativeDir}/*-schema.json`], {
    cwd: root,
    encoding: "utf8",
  }),
  appSchemaRelativeDir,
);
const namespacedPermissionIds = permissionIds.map((identifier) => `zcash:${identifier}`);
const expectedAppSchemaIds = [...namespacedPermissionIds, "zcash:default"];
const appSchemas = appSchemaNames.map((name) => {
  const contents = fs.readFileSync(path.join(appSchemaDir, name));
  const schema = JSON.parse(contents);
  const identifiers = unique(
    collectConsts(schema).filter((value) => value.startsWith("zcash:")),
    `${name} Zcash permission identifiers`,
  );
  assertSameSet(
    expectedAppSchemaIds,
    identifiers,
    `generated permissions and ${name}`,
  );
  return { name, contents };
});
assertIdentical(appSchemas, "tracked Zuuallet target schemas");

console.log(
  `Zcash permission generation matches ${commands.length} registered commands and ${permissionIds.length} permission identifiers across ${appSchemas.length} tracked target schemas.`,
);
