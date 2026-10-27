#!/usr/bin/env node
// Preflight for `npm test`: prove the local toolchain can produce a *trustworthy*
// test result before a single test runs.
//
// Why this exists. Two local traps produced misleading results here, and
// both cost real triage time:
//
//   1. An incomplete `node_modules` in the primary checkout — `marked-footnote`,
//      `marked-gfm-heading-id`, `@playwright/test` and `@resvg/resvg-js` were on
//      disk in the lockfile but not in the tree. ~45 unrelated suites failed with
//      ERR_MODULE_NOT_FOUND. That reads exactly like a regression: one reviewer
//      reported "789 pass, 3 pre-existing failures" from that tree while a clean
//      `npm ci` gave a fully green suite. The danger is not the noise, it is that
//      a *genuine* failure gets waved off as "the known broken node_modules".
//
//   2. `engines.node` is >=24 and CI runs Node 24, but a default shell may sit on
//      22. On Node 22 the `.ts` test files fail to load outright with
//      ERR_UNKNOWN_FILE_EXTENSION (type stripping for `.ts` only lands in 22.18).
//      A toolchain artifact that is indistinguishable from a suite failure.
//
// Both are cheap to detect and expensive to misdiagnose, so we detect them.
// This runs as the `pretest` lifecycle script: no hook to install, nothing to
// remember, and it costs a few milliseconds. It never installs anything and
// never writes to the tree — it prints the exact command to run and exits 1.
//
// Deliberately NOT a `npm ls` / `npm ci --dry-run` shell-out: those take seconds
// and hit the network. This reads package-lock.json and each installed package's
// own package.json — ~780 small reads, under 200ms — ahead of a suite that takes
// minutes.

import { readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = "npm ci   # in ts/svelte/free2z";

const problems = [];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. Node version vs engines.node
// ---------------------------------------------------------------------------

const pkg = readJson(join(pkgRoot, "package.json"));
if (!pkg) {
  console.error(
    "preflight: cannot read package.json — is this the right directory?",
  );
  process.exit(1);
}

// engines.node is "^24.15.0 || >=26.0.0" today — narrowed from ">=24.0.0" in
//  to match `isomorphic-dompurify@3` / `jsdom@30`, which declare
// `^22.22.2 || ^24.15.0 || >=26.0.0` and so exclude both 24.0-24.14 and the
// whole (non-LTS) 25 line. npm only *warns* (EBADENGINE) about a transitive
// engine miss, so the manifest is the only place that record exists.
//
// This guard still reads the FIRST floor in the range (24.15.0) and enforces
// only that lower bound: a hypothetical Node 25 passes here. That is deliberate
// and unchanged — an upper bound is not what this guard is about, and the floor
// is read out of the range wherever it appears, so a later ">=24 <26" or
// "^24.18.0" keeps working. This deliberately does not pull in semver: the dependency would have to be present
// for the check that detects absent dependencies to run.
//
// The floor is compared as a full major.minor.patch triple, not just the major.
// The trap this guard exists for is *itself* a minor-version boundary — `.ts`
// type stripping lands in 22.18, not in 22.0 — so the day the floor moves to
// something like ">=24.18.0" for a specific fix, a major-only compare would wave
// 24.0.0 through and reintroduce exactly the failure mode being guarded.
//
// Accepted shapes are ">=24.0.0", "^24", "~24.18", the bare "24", and "24.x" /
// "24.*" — every form npm's docs use for a floor; an `x` or `*` component reads
// as 0, which is what those ranges mean. Anything left unparseable is announced
// on stderr rather than passing in silence: a version check that quietly stopped
// checking is how the original Node-22 confusion survives a manifest edit nobody
// connected with it.
const engine = pkg.engines?.node ?? "";
const want = /(?:>=|\^|~)?\s*(\d+)(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?/.exec(
  engine,
);
if (engine && !want) {
  console.error(
    `preflight: engines.node "${engine}" has no lower bound this check can read;` +
      " the Node version was NOT verified. Widen the parser in scripts/preflight.mjs.",
  );
}
const asTriple = (parts) =>
  parts.map((part) => (Number.isFinite(Number(part)) ? Number(part) : 0));
if (want) {
  const wantParts = asTriple([want[1], want[2], want[3]]);
  const haveParts = asTriple(process.versions.node.split("."));
  // Compare component by component and stop at the first difference, so a
  // larger later component cannot mask a smaller earlier one (24.0.9 must
  // still be "older" than a 24.1.0 floor).
  let tooOld = false;
  for (let i = 0; i < 3; i += 1) {
    if (haveParts[i] === wantParts[i]) continue;
    tooOld = haveParts[i] < wantParts[i];
    break;
  }
  if (tooOld) {
    problems.push(
      `Node ${process.versions.node} is older than engines.node "${engine}".\n` +
        `    Below that floor the .ts test files can fail to load with ERR_UNKNOWN_FILE_EXTENSION\n` +
        `    (type stripping for .ts only lands in 22.18), which looks identical to a real test\n` +
        `    failure but is not one.\n` +
        `    Fix: nvm use ${wantParts[0]}   (CI runs Node ${wantParts[0]})`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. package.json vs package-lock.json
// ---------------------------------------------------------------------------
//
// The two files are committed together, so they normally agree — but a merge
// that took `package.json` from one side and `package-lock.json` from the other
// leaves them describing different graphs, and the resulting tree still matches
// the (stale) lock. Everything downstream then passes while the import of the
// newly declared dependency fails with ERR_MODULE_NOT_FOUND: the phantom
// regression again, one level up. Worth catching here because the state is
// invisible to every other check, and because `npm ci` — the fix this script
// prescribes everywhere else — will *refuse* to run in it, which is confusing
// advice unless the real cause is named.

const lock = readJson(join(pkgRoot, "package-lock.json"));
const hidden = readJson(join(pkgRoot, "node_modules", ".package-lock.json"));

if (lock) {
  const rootEntry = lock.packages?.[""] ?? {};
  const drifted = [];
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const declared = pkg[field] ?? {};
    const locked = rootEntry[field] ?? {};
    for (const name of new Set([
      ...Object.keys(declared),
      ...Object.keys(locked),
    ])) {
      if (declared[name] === locked[name]) continue;
      drifted.push(
        `${field}.${name} (package.json ${declared[name] ?? "absent"}, lock ${locked[name] ?? "absent"})`,
      );
    }
  }
  if (drifted.length) {
    const head = drifted.slice(0, 5).map((entry) => `      - ${entry}`);
    if (drifted.length > 5) head.push(`      … and ${drifted.length - 5} more`);
    problems.push(
      `package.json and package-lock.json describe different dependencies:\n` +
        `${head.join("\n")}\n` +
        `    npm ci will refuse to run until they agree. Fix the manifest (a merge\n` +
        `    usually took one file from each side), then: npm install --package-lock-only`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. node_modules vs package-lock.json
// ---------------------------------------------------------------------------

if (!lock) {
  problems.push("package-lock.json is missing or unreadable.");
} else if (!hidden) {
  problems.push(
    "node_modules/.package-lock.json is missing — the dependency tree was never\n" +
      `    installed by npm, or the install was interrupted.\n    Fix: ${FIX}`,
  );
} else {
  const lockPkgs = lock.packages ?? {};
  const treePkgs = hidden.packages ?? {};

  // Which lockfile entries a *correct* tree is allowed to be missing.
  //
  // `optional: true` alone is NOT the answer, and getting this wrong in either
  // direction is expensive. Skip too much and the guard passes a tree that is
  // genuinely broken: `@resvg/resvg-js-darwin-arm64`, `@esbuild/darwin-arm64`
  // and `@rollup/rollup-darwin-arm64` are all marked optional, yet on this host
  // they are exactly the packages whose absence produces "Failed to load native
  // binding" from the OG-card routes — the misleading failure this guard exists
  // to prevent. Skip too little and the guard is red on a healthy tree, which
  // gets it deleted along with the checks that do work.
  //
  // So gate on npm's own `os`/`cpu`/`libc` constraints instead: an optional
  // package is excused only when its own metadata says it does not belong on
  // this host. The ~110 excused entries here are foreign-platform binaries; the
  // one matching this host is required and must be present.
  //
  // `libc` is not optional to handle, and leaving it out is worse than useless:
  // 25 lockfile entries carry it, in glibc/musl pairs (@resvg/resvg-js-linux-*,
  // @rollup/rollup-linux-*, @tailwindcss/oxide-linux-*, lightningcss-linux-*).
  // On the glibc Ubuntu runner both members of every pair match on os and cpu,
  // so an os/cpu-only rule would demand the musl half that `npm ci` correctly
  // never installs — turning the required `ui` gate red after a clean install
  // and blocking every subsequent UI PR. Alpine would fail the mirror image.
  // Node exposes the runtime's libc as glibcVersionRuntime in its process
  // report; its absence on Linux means musl.
  const hostLibc =
    process.platform === "linux"
      ? process.report?.getReport?.()?.header?.glibcVersionRuntime
        ? "glibc"
        : "musl"
      : null;
  const hostMatches = (list, value) => {
    if (!Array.isArray(list) || list.length === 0) return true;
    // `value === null` means this constraint does not apply on this platform
    // (libc off Linux); treat it as satisfied rather than as a mismatch.
    if (value === null) return true;
    if (list.some((entry) => entry.startsWith("!") && entry.slice(1) === value))
      return false;
    const allowed = list.filter((entry) => !entry.startsWith("!"));
    return allowed.length === 0 || allowed.includes(value);
  };
  const wrongHost = (meta) =>
    !hostMatches(meta.os, process.platform) ||
    !hostMatches(meta.cpu, process.arch) ||
    !hostMatches(meta.libc, hostLibc);

  // An excused package takes its nested dependencies with it. Only the
  // foreign-arch package itself carries the os/cpu metadata; its children
  // under `<path>/node_modules/...` are ordinary entries that are equally
  // absent, and reporting them was the first false positive this check hit
  // (@tailwindcss/oxide-wasm32-wasi's six @emnapi/@napi-rs children).
  const excusedRoots = [];
  for (const [path, meta] of Object.entries(lockPkgs)) {
    if (path !== "" && meta.optional && wrongHost(meta))
      excusedRoots.push(`${path}/`);
  }
  const excusedPaths = new Set(
    Object.entries(lockPkgs)
      .filter(
        ([path, meta]) =>
          (meta.optional && wrongHost(meta)) ||
          excusedRoots.some((root) => path.startsWith(root)),
      )
      .map(([path]) => path),
  );

  // npm can hoist a foreign binary's dependencies to top-level node_modules.
  // Resolve the lockfile edges with Node's nearest-ancestor lookup, then
  // excuse an optional child only when EVERY referring parent is excused.
  // A shared dependency needed on this host stays required. Orphan entries
  // also stay required: absence of an edge is not proof of a foreign parent.
  const resolveDependency = (parent, name) => {
    let directory = parent;
    for (;;) {
      const candidate = posix.join(directory, "node_modules", name);
      if (candidate in lockPkgs) return candidate;
      if (!directory || directory === ".") return null;
      directory = posix.dirname(directory);
    }
  };
  const parents = new Map();
  for (const [path, meta] of Object.entries(lockPkgs)) {
    const dependencies = {
      ...meta.dependencies,
      ...meta.optionalDependencies,
      ...meta.peerDependencies,
      ...(path === "" ? meta.devDependencies : {}),
    };
    for (const name of Object.keys(dependencies)) {
      const child = resolveDependency(path, name);
      if (!child) continue;
      if (!parents.has(child)) parents.set(child, new Set());
      parents.get(child).add(path);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [path, referers] of parents) {
      if (
        !excusedPaths.has(path) &&
        lockPkgs[path].optional &&
        [...referers].every((parent) => excusedPaths.has(parent))
      ) {
        excusedPaths.add(path);
        changed = true;
      }
    }
  }
  const isExcused = (path) => excusedPaths.has(path);

  // Presence and version both come from each package's own package.json on
  // disk, never from npm's hidden lockfile. That file records what npm
  // *believes* it installed and can outlive the truth — a half-finished
  // install, a hand-swapped directory, a package deleted by hand all leave it
  // stale — so trusting it would let the preflight bless a tree running a
  // different version than the lockfile pins.
  // A `peer: true` entry is excused only while npm's own resolution agrees it
  // is not there. openapi-types is recorded by orval and never materialises in
  // any tree, so demanding it would be red on a healthy checkout — but a peer
  // npm *did* place and something later deleted is a real broken tree, and
  // deferring to the hidden lockfile here is the one place its claim is the
  // right question to ask (it is npm's record of what it chose to install, not
  // of what is on disk now).
  const unresolvedPeer = (path, meta) => meta.peer && !(path in treePkgs);

  const missing = [];
  const mismatched = [];
  for (const [path, meta] of Object.entries(lockPkgs)) {
    if (path === "") continue; // the project root itself
    if (meta.link || unresolvedPeer(path, meta)) continue;
    const excused = isExcused(path, meta);
    const onDisk = readJson(join(pkgRoot, path, "package.json"));
    if (!onDisk) {
      if (!excused) missing.push(path);
      continue;
    }
    if (meta.version && onDisk.version && meta.version !== onDisk.version) {
      mismatched.push(
        `${path} (lock ${meta.version}, on disk ${onDisk.version})`,
      );
    }
  }

  // The reverse direction catches a tree that is *ahead* of the lockfile —
  // somebody ran `npm install <pkg>` and never committed the lockfile change.
  const extra = Object.keys(treePkgs).filter((path) => !(path in lockPkgs));

  const describe = (list) => {
    const head = list.slice(0, 5).map((entry) => `      - ${entry}`);
    if (list.length > 5) head.push(`      … and ${list.length - 5} more`);
    return head.join("\n");
  };

  if (missing.length) {
    problems.push(
      `${missing.length} package(s) in package-lock.json are missing from disk:\n` +
        `${describe(missing)}\n` +
        `    Imports of these fail with ERR_MODULE_NOT_FOUND (or, for a native binding,\n` +
        `    "Failed to load native binding"), which looks like a regression.\n` +
        `    Fix: ${FIX}`,
    );
  }
  if (mismatched.length) {
    problems.push(
      `${mismatched.length} package(s) are installed at the wrong version:\n` +
        `${describe(mismatched)}\n    Fix: ${FIX}`,
    );
  }
  if (extra.length) {
    problems.push(
      `${extra.length} installed package(s) are not in package-lock.json:\n` +
        `${describe(extra)}\n` +
        `    The tree is ahead of the lockfile — commit the lockfile, or ${FIX}`,
    );
  }
}

if (problems.length) {
  console.error("");
  console.error(
    "  npm test preflight FAILED — the suite result would not be trustworthy.",
  );
  console.error("");
  for (const problem of problems) console.error(`  ✖ ${problem}\n`);
  console.error("  See issue #1317 for why this check exists.");
  console.error("");
  process.exit(1);
}
