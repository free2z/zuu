#!/usr/bin/env node
// Ownership is data. A new independent project does not require a code change.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "scripts/project-namespaces.json"), "utf8"));
const beneath = (file, directory) => file === directory || file.startsWith(`${directory}/`);
const canonical = (path) => typeof path === "string" && path.length > 0 &&
  !path.startsWith("/") && !path.endsWith("/") && !path.includes("\\") &&
  path.split("/").every((part) => part && part !== "." && part !== "..");

export function check(paths, registry) {
  const errors = [];
  if (registry.version !== 1 || !Array.isArray(registry.documentation) || !Array.isArray(registry.retired)) {
    return ["invalid namespace registry shape"];
  }
  for (const entry of registry.documentation) {
    if (!canonical(entry.path) || !entry.path.startsWith("docs/") ||
        typeof entry.owner !== "string" || !entry.owner.trim() ||
        typeof entry.scope !== "string" || !entry.scope.trim()) {
      errors.push("documentation registrations require canonical path, owner and scope");
    }
  }
  for (const path of registry.retired) {
    if (!canonical(path)) errors.push("retired paths must be canonical repository-relative paths");
  }
  if (errors.length) return errors;
  const entries = registry.documentation;
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (beneath(entries[i].path, entries[j].path) || beneath(entries[j].path, entries[i].path)) {
        errors.push(`overlapping documentation ownership: ${entries[i].path}, ${entries[j].path}`);
      }
    }
    if (registry.retired.some((old) => beneath(entries[i].path, old) || beneath(old, entries[i].path))) {
      errors.push(`retired location cannot be registered: ${entries[i].path}`);
    }
  }
  for (const file of paths) {
    if (registry.retired.some((old) => beneath(file, old))) {
      errors.push(`retired ambiguous project location: ${file}`);
    } else if (file.startsWith("docs/") && !entries.some((entry) => beneath(file, entry.path))) {
      errors.push(`unregistered documentation namespace: ${file}`);
    }
  }
  return errors;
}

function selfTest() {
  const base = structuredClone(manifest);
  assert.deepEqual(check(["docs/free2z/sdk/README.md", "docs/zuu/NAMESPACES.md", "rs/crates/example/src/lib.rs"], base), []);
  // Independent SDKs/projects are legitimate; ownership is extensible data.
  base.documentation.push({path:"docs/independent-project",owner:"independent-project",scope:"Unrelated scientific tools and SDK"});
  assert.deepEqual(check(["docs/free2z/sdk/README.md", "docs/independent-project/sdk/README.md", "docs/independent-project/architecture.md", "ts/independent-project/sdk/index.ts"], base), []);
  for (const old of manifest.retired) {
    assert(check([old.endsWith(".md") ? old : `${old}/README.md`], base).some((e) => e.includes("retired ambiguous")), old);
  }
  assert(check(["docs/unregistered/README.md"], base).some((e) => e.includes("unregistered")));
  const overlap = structuredClone(base);
  overlap.documentation.push({path:"docs/free2z/sdk",owner:"other",scope:"Conflict"});
  assert(check([], overlap).some((e) => e.includes("overlapping")));
  const resurrected = structuredClone(base);
  resurrected.documentation.push({path:"docs/sdk",owner:"other",scope:"Cannot override a retired path"});
  assert(check([], resurrected).some((e) => e.includes("cannot be registered")));
  const malformed = structuredClone(base);
  malformed.documentation[0].path = "docs/../outside";
  assert(check([], malformed).some((e) => e.includes("canonical")));
  console.log(`Namespace self-test passed: ${manifest.retired.length} retired locations, independent owners/SDKs, unregistered scope, overlap, resurrection and invalid registry.`);
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const files = execFileSync("git", ["ls-files", "-z"], {cwd:root,encoding:"utf8"}).split("\0").filter(Boolean);
  const errors = check(files, manifest);
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log(`Project namespace ownership passed for ${files.length} tracked paths.`);
}
