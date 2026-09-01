#!/usr/bin/env node
//
// Enforce `docs/DEPENDENCIES.md` — the fork & pin register.
//
// `AGENTS.md` says a fork is "a bridge, never a parking spot": branch, PR, pin
// transiently, and move the submodule back to upstream `main` the moment the PR
// merges. That policy is right and nothing enforced step 5. Two things went
// wrong before this script existed, and both were found only because a human
// went looking:
//
//   * the librustzcash fork sat ten commits behind upstream `main`, so the
//     thing we built was not the thing under review upstream; and
//   * `z/ZcashFoundation/z3`'s `.gitmodules` `branch` named `dev` for months
//     after upstream deleted it, which made `git submodule update --remote`
//     unable to resolve that submodule at all — silently, and forever (#847).
//
// Neither is a code change, so no build could go red for either. This script is
// what goes red instead.
//
// TWO HALVES, ON PURPOSE.
//
//   OFFLINE (default). Reads only files in this repository: `.gitmodules`, the
//   manifests carrying `[patch.crates-io]`, every constraint source a version
//   hold names, and the register itself. Deterministic, so it is safe on a pull
//   request and runs on one.
//
//   UPSTREAM (`--upstream`). Asks github.com and crates.io whether an exit
//   condition has fired, how far a fork has drifted, and whether every
//   `.gitmodules` `branch` still exists on its remote. Every verdict here is a
//   statement about someone else's repository, so this is deliberately NOT a
//   required check: upstream merging zcash/librustzcash#3010 is good news and
//   must not redden `main` for a contributor who touched none of it. It runs
//   weekly from `.github/workflows/dependency-register.yml` and files an issue.
//
// The registry below is a set of reviewed literals, not values derived from the
// files under judgement — deriving them would make a stale pin self-approving,
// the same reason `scripts/check-librustzcash-compat.mjs` holds its gitlink as
// a literal.
//
// EVERY HOLD NAMES THE SOURCE THAT VERIFIES IT.
//
// The first version of this script re-read one file — librustzcash's
// `[workspace.dependencies]` — which is why it caught `sha2`'s justification
// being wrong. But not every hold this repository carries is librustzcash's:
// `chacha20poly1305` 0.10 is `zcash_note_encryption`'s requirement, and
// `getrandom` 0.3 is `tauri`'s, a registry crate that is not vendored in `z/`
// at all. A row justified by a source the checker does not read is exactly the
// claim that rotted before, wearing a checked-looking badge.
//
// So `HOLDS` is a list of `{ crate, held, source }` and `source.kind` chooses
// the reader: `manifest` re-reads a named dependency table in a named TOML
// file, `lockfile` re-reads a resolved `Cargo.lock` and asserts that a named
// package at a named version still pulls the held crate, and `ours` asserts
// the negative — that no registered upstream source declares the crate at all.
// `parseHoldTable` then reads section 3 of the register back and requires the
// two to agree row for row, so a hold cannot be *added to the page* without a
// source the checker reads either.
//
// Usage:
//   node scripts/check-dependency-register.mjs              offline verdict
//   node scripts/check-dependency-register.mjs --self-test   negative controls
//   node scripts/check-dependency-register.mjs --upstream    network verdict

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const REGISTER_PATH = "docs/DEPENDENCIES.md";
const GITMODULES_PATH = ".gitmodules";
const LIBRUSTZCASH_MANIFEST = "z/zcash/librustzcash/Cargo.toml";
const NOTE_ENCRYPTION_MANIFEST = "z/zcash/zcash_note_encryption/Cargo.toml";
const ZUULI_LOCK = "wallet/zuuli/src-tauri/Cargo.lock";

/// The four locks that resolve a shipping wallet binary or the plugins it is
/// built from. `rs/Cargo.lock` is deliberately not one of them: it resolves the
/// server-side workspace, whose graph is a different question.
const WALLET_LOCKS = [
  "wallet/plugins/tauri-plugin-zcash/Cargo.lock",
  "wallet/plugins/tauri-plugin-f2zmsg/Cargo.lock",
  "wallet/zuuallet/src-tauri/Cargo.lock",
  ZUULI_LOCK,
];

/// Manifests allowed to carry a `[patch.crates-io]` section. A patch anywhere
/// else is a fork nobody registered, so the enumeration is the point: the
/// offline check reads every tracked `Cargo.toml` and fails on a patch section
/// in a file that is not on this list.
const PATCHABLE_MANIFESTS = ["wallet/zuuli/src-tauri/Cargo.toml"];

/// GitHub owners whose repositories are *ours*. A `.gitmodules` `url` under one
/// of these is by definition a fork we are carrying, and must be registered.
const FORK_OWNERS = new Set(["free2z"]);

/// How far behind its upstream base a fork branch may fall before this is a
/// finding. Ten is the drift that was discovered by hand — rebasing a one-commit
/// fork forward is cheap and scripted, so the threshold is set where the failure
/// actually happened rather than somewhere comfortable.
const DEFAULT_DRIFT_LIMIT = 10;

/// How stale the register's `<!-- verified: -->` marker may get before the
/// weekly run says so. Offline runs only parse the date; letting time alone
/// fail a pull request would be a gate on the calendar.
const REGISTER_MAX_AGE_DAYS = 90;

/// Every fork and pin this repository carries, with the event that retires it.
///
/// `registerTokens` are strings `docs/DEPENDENCIES.md` must contain. They are
/// what stops the register from being edited into vagueness while the pin stays:
/// deleting the exit condition from the page fails here.
const TRACKED = [
  {
    id: "z/zcash/librustzcash",
    kind: "submodule",
    forkUrl: "https://github.com/free2z/librustzcash",
    forkBranch: "f2z/drop-stale-rustcrypto-rc-pins",
    /// #3010's head is a DIFFERENT branch on the same fork. Both must stay at
    /// the same commit or we are building something upstream is not reviewing.
    prHeadBranch: "f2z/upstream-drop-stale-rustcrypto-rc-pins",
    upstreamRepo: "zcash/librustzcash",
    upstreamBranch: "main",
    exitPr: 3010,
    driftLimit: DEFAULT_DRIFT_LIMIT,
    registerTokens: [
      "https://github.com/free2z/librustzcash",
      "f2z/drop-stale-rustcrypto-rc-pins",
      "f2z/upstream-drop-stale-rustcrypto-rc-pins",
      "zcash/librustzcash#3010",
    ],
  },
  {
    id: "bip32",
    kind: "patch",
    manifest: "wallet/zuuli/src-tauri/Cargo.toml",
    forkUrl: "https://github.com/free2z/crates",
    forkRev: "131d490ef75ccd23111cc7f3df91e4a88fc971ae",
    upstreamRepo: "iqlusioninc/crates",
    upstreamBranch: "main",
    /// Not a PR. This one retires on a registry event plus an upstream version
    /// move, both of which `--upstream` checks by name.
    exitCrate: { name: "bip32", stableAtLeast: "0.6.0" },
    exitDependencyMove: { crate: "secp256k1", awayFrom: "0.29" },
    driftLimit: DEFAULT_DRIFT_LIMIT,
    registerTokens: [
      "https://github.com/free2z/crates",
      "131d490ef75ccd23111cc7f3df91e4a88fc971ae",
      "0.6.0-pre.1",
    ],
  },
];

/// Every deliberate version hold, with the source that verifies it.
///
/// This is the rule that keeps section 3 of the register honest. Each entry is
/// a claim the register makes about who forces a hold; if upstream bumps
/// `rusqlite` to 0.38, the register's row becomes false and this goes red
/// instead of the page quietly lying.
///
/// `source.kind`:
///
///   `manifest`  — `path`'s `[table]` must declare `crate` at exactly
///                 `requires`. The strongest form: it reads the requirement
///                 the upstream author wrote, so a bump upstream is caught the
///                 moment the submodule moves.
///   `lockfile`  — `path`'s resolved graph must still contain `forcedBy.name`
///                 at `forcedBy.version`, and that package must still depend on
///                 `crate` on the `held` line. Weaker than a manifest read (a
///                 lockfile is a resolution, not a requirement) and used only
///                 where the forcing crate is a registry dependency with no
///                 manifest in this tree. It fails loudly when the forcing
///                 crate is bumped, which is precisely when the row needs
///                 re-verifying by a human.
///   `ours`      — the negative claim. `crate` must appear in NO registered
///                 `manifest` source, because "our own choice" stops being true
///                 the moment an upstream takes a position.
///
/// `registerToken` is the string the row's own line in section 3 must contain,
/// so a row cannot name a different source from the one being read.
/// `registerRow: false` means the hold is checked but does not live in section
/// 3's table — `bip32` is section 2's, and is here because its requirement is
/// half of that patch's exit condition.
///
/// `evidence` is the *measured consequence* a row states, re-read from a
/// resolved lockfile. This is the rule §3's `rand` row needed and did not have:
/// it claimed the shipping lock carried "0.8, 0.9 and 0.10" long after #855
/// collapsed the 0.9 island, and the check passed anyway because it was reading
/// librustzcash's manifest — the right source for *who forces the hold*, and
/// the wrong one for *what the graph actually contains*. Both are claims; both
/// now have a reader.
///
///   `copies`    — the exact set of versions of a crate present in one lockfile.
///   `edge`      — a named package in one lockfile resolves a crate on a named
///                 line, which is how "they all share this copy" is verified.
///   `consumers` — how many packages resolve a crate on a named line. The
///                 register states these counts ("11 packages, including …"),
///                 so they are numbers a reader will trust, and a number nobody
///                 re-reads is the thing this file exists to prevent.
///
/// `rowClaim` / `sectionClaim` close the other half of that gap. Re-reading the
/// measurement is not enough on its own: the `rand` row went on saying "0.8, 0.9
/// and 0.10" while the lock said otherwise, so the SENTENCE has to carry the
/// number too. `claimText` derives the phrase from the measurement, which is
/// why the two cannot drift — changing the prose means changing the number the
/// check read, and changing the number rewrites the phrase the prose must use.
const HOLDS = [
  {
    crate: "rusqlite",
    held: "0.37",
    source: { kind: "manifest", path: LIBRUSTZCASH_MANIFEST, table: "workspace.dependencies", requires: "0.37" },
    registerToken: "z/zcash/librustzcash",
  },
  {
    crate: "secrecy",
    held: "0.8",
    source: { kind: "manifest", path: LIBRUSTZCASH_MANIFEST, table: "workspace.dependencies", requires: "0.8" },
    registerToken: "z/zcash/librustzcash",
  },
  {
    crate: "secp256k1",
    held: "0.29",
    source: { kind: "manifest", path: LIBRUSTZCASH_MANIFEST, table: "workspace.dependencies", requires: "0.29" },
    registerToken: "z/zcash/librustzcash",
  },
  {
    crate: "rand",
    held: "0.8",
    source: { kind: "manifest", path: LIBRUSTZCASH_MANIFEST, table: "workspace.dependencies", requires: "0.8" },
    registerToken: "z/zcash/librustzcash",
    /// The row that was wrong. It said "0.8, 0.9 and 0.10" after #855 had
    /// already collapsed the 0.9 island, and nothing re-read it.
    evidence: [
      { kind: "copies", path: ZUULI_LOCK, versions: ["0.8.7", "0.10.2"], rowClaim: true },
      {
        kind: "copies",
        crate: "rand_core",
        path: ZUULI_LOCK,
        versions: ["0.6.4", "0.10.1"],
      },
    ],
  },
  {
    crate: "sha2",
    held: "0.10",
    source: { kind: "manifest", path: LIBRUSTZCASH_MANIFEST, table: "workspace.dependencies", requires: "0.10" },
    registerToken: "z/zcash/librustzcash",
    /// The correction below §3's table used to say moving `f2z-msg-identity`
    /// to 0.11 "would add a second SHA-256 to the shipped wallet". It would
    /// not, any more: the MLS half of the graph brought 0.11.0 in, and it has
    /// been there unremarked. The cost is real but it is a *defection* from
    /// the copy the Zcash half shares, not a new copy — a second row that
    /// nothing re-read, found by the same rule that found `rand`'s.
    evidence: [
      { kind: "copies", path: ZUULI_LOCK, versions: ["0.10.9", "0.11.0"], sectionClaim: true },
      { kind: "consumers", path: ZUULI_LOCK, on: "0.10", count: 14, sectionClaim: true },
      { kind: "consumers", path: ZUULI_LOCK, on: "0.11", count: 4, sectionClaim: true },
      { kind: "edge", path: ZUULI_LOCK, from: { name: "f2z-msg-identity" }, on: "0.10" },
      { kind: "edge", path: ZUULI_LOCK, from: { name: "zcash_primitives" }, on: "0.10" },
    ],
  },
  {
    crate: "ripemd",
    held: "0.1",
    source: { kind: "manifest", path: LIBRUSTZCASH_MANIFEST, table: "workspace.dependencies", requires: "0.1" },
    registerToken: "z/zcash/librustzcash",
    /// `bip32` already carries 0.2.0, so the row's claim is deliberately NOT
    /// "bumping adds a copy" — it is that 0.2 is on `digest 0.11` while the
    /// `Sha256` beside it in `hash160` stays on `digest 0.10`.
    evidence: [
      { kind: "copies", path: ZUULI_LOCK, versions: ["0.1.3", "0.2.0"] },
      { kind: "edge", path: ZUULI_LOCK, from: { name: "zcash_transparent" }, on: "0.1" },
      { kind: "edge", path: ZUULI_LOCK, from: { name: "zcash_script" }, on: "0.1" },
      /// 0.2.0 is already here via `bip32`, which is why the row's cost is a
      /// split `digest` trait rather than an extra copy.
      { kind: "edge", path: ZUULI_LOCK, from: { name: "bip32" }, on: "0.2" },
      { kind: "copies", crate: "digest", path: ZUULI_LOCK, versions: ["0.10.7", "0.11.3"] },
      /// The whole cost of the row, in two lines: the held `ripemd` is on
      /// `digest 0.10` with `sha2`, and 0.2 is on `digest 0.11` without it.
      { kind: "edge", crate: "digest", path: ZUULI_LOCK, from: { name: "ripemd", version: "0.1.3" }, on: "0.10" },
      { kind: "edge", crate: "digest", path: ZUULI_LOCK, from: { name: "ripemd", version: "0.2.0" }, on: "0.11" },
      { kind: "edge", crate: "digest", path: ZUULI_LOCK, from: { name: "sha2", version: "0.10.9" }, on: "0.10" },
    ],
  },
  {
    crate: "nonempty",
    held: "0.11",
    source: { kind: "manifest", path: LIBRUSTZCASH_MANIFEST, table: "workspace.dependencies", requires: "0.11" },
    registerToken: "z/zcash/librustzcash",
    evidence: [
      { kind: "copies", path: ZUULI_LOCK, versions: ["0.11.0"] },
      { kind: "edge", path: ZUULI_LOCK, from: { name: "zcash_client_backend" }, on: "0.11" },
      { kind: "consumers", path: ZUULI_LOCK, on: "0.11", count: 9, rowClaim: true },
    ],
  },
  {
    crate: "base64",
    held: "0.22",
    source: { kind: "manifest", path: LIBRUSTZCASH_MANIFEST, table: "workspace.dependencies", requires: "0.22" },
    registerToken: "z/zcash/librustzcash",
    /// Three copies already, so the row's claim is about *alignment*, not
    /// duplication: 0.22.1 is the copy librustzcash's own crates resolve to.
    evidence: [
      { kind: "copies", path: ZUULI_LOCK, versions: ["0.21.7", "0.22.1", "0.23.1"] },
      { kind: "edge", path: ZUULI_LOCK, from: { name: "zcash_client_backend" }, on: "0.22" },
      { kind: "edge", path: ZUULI_LOCK, from: { name: "zip321" }, on: "0.22" },
      { kind: "consumers", path: ZUULI_LOCK, on: "0.22", count: 11, rowClaim: true },
      /// The island the row says bumping would move us onto, measured so
      /// "for nothing" is a checked statement rather than a rhetorical one.
      { kind: "consumers", path: ZUULI_LOCK, on: "0.23", count: 2 },
    ],
  },
  {
    crate: "bip0039",
    held: "0.12",
    source: { kind: "manifest", path: LIBRUSTZCASH_MANIFEST, table: "workspace.dependencies", requires: "0.12" },
    registerToken: "z/zcash/librustzcash",
    /// The row's honest weakness: upstream declares `bip0039` only `optional`,
    /// so today `tauri-plugin-zcash` is the lock's ONLY consumer. If that count
    /// ever moves, upstream has turned a feature on and the row gets stronger —
    /// either way somebody re-reads it.
    evidence: [
      { kind: "copies", path: ZUULI_LOCK, versions: ["0.12.0"] },
      { kind: "consumers", path: ZUULI_LOCK, on: "0.12", count: 1, rowClaim: true },
    ],
  },
  {
    /// NOT librustzcash's. `zcash_note_encryption` is its own crate with its
    /// own `[dependencies]`, and it is the reason every wallet lock carries
    /// exactly one ChaCha20-Poly1305.
    crate: "chacha20poly1305",
    held: "0.10",
    source: { kind: "manifest", path: NOTE_ENCRYPTION_MANIFEST, table: "dependencies", requires: "0.10" },
    registerToken: "z/zcash/zcash_note_encryption/Cargo.toml",
    /// "Ours is currently the only copy" is the whole reason bumping to 0.11
    /// costs a second AEAD in every wallet binary. One copy per wallet lock is
    /// the measurement, so that is what is asserted.
    evidence: [
      ...WALLET_LOCKS.map((lockPath) => ({
        kind: "copies",
        path: lockPath,
        versions: ["0.10.1"],
      })),
      {
        kind: "edge",
        path: ZUULI_LOCK,
        from: { name: "zcash_note_encryption" },
        on: "0.10",
      },
      /// Five: ours twice, plus zcash_note_encryption, hpke-rs-rust-crypto and
      /// openmls_rust_crypto. Three of the five are not ours to move, which is
      /// what makes a 0.11 bump cost a second AEAD rather than a migration.
      { kind: "consumers", path: ZUULI_LOCK, on: "0.10", count: 5, rowClaim: true },
    ],
  },
  {
    /// NOT any `z/` submodule's. `tauri` is a registry crate, so there is no
    /// manifest here to re-read — the resolved lock is the only in-tree
    /// evidence, and it is enough: it names the exact version whose
    /// requirement was read by hand, so a tauri bump re-opens the question.
    crate: "getrandom",
    held: "0.3",
    source: {
      kind: "lockfile",
      path: ZUULI_LOCK,
      forcedBy: { name: "tauri", version: "2.11.5" },
    },
    registerToken: "tauri 2.11.5",
    /// The row says bumping ours to 0.4 would not retire tauri's copy, because
    /// the graph already carries all three lines. That is the fact that makes
    /// the hold about alignment rather than duplication.
    evidence: [
      {
        kind: "copies",
        path: ZUULI_LOCK,
        versions: ["0.2.17", "0.3.4", "0.4.3"],
        rowClaim: true,
      },
    ],
  },
  {
    crate: "hkdf",
    held: "0.12",
    source: { kind: "ours" },
    registerToken: "Our own choice",
  },
  {
    /// Section 2's, not section 3's: this requirement is the second half of the
    /// `bip32` patch's exit condition, and `--upstream` watches it move.
    crate: "bip32",
    held: "=0.6.0-pre.1",
    source: { kind: "manifest", path: LIBRUSTZCASH_MANIFEST, table: "workspace.dependencies", requires: "=0.6.0-pre.1" },
    registerRow: false,
  },
];

/// Every file a hold names — as its constraint source, or as the lockfile a
/// measured consequence was read off. `liveSnapshot` reads these and nothing
/// else, and the set is derived from `HOLDS` so adding a hold with a new source
/// cannot forget to read it.
const HOLD_SOURCE_PATHS = [
  ...new Set(
    HOLDS.flatMap((hold) => [
      hold.source.path,
      ...(hold.evidence ?? []).map((item) => item.path),
    ]).filter(Boolean),
  ),
];

/// The remaining register sections that are not a fork or a hold, each with the
/// token that proves the section survived an edit.
const NARRATIVE_TOKENS = [
  // 4. openmls_memory_storage — cross-referenced, never duplicated.
  "openmls_memory_storage",
  // BOTH numbers, deliberately. #2188 is the issue and #2163 is the pull
  // request that fixed it; an earlier draft of the register asserted that
  // #2188 "does not exist" because `/pulls/2188` 404s for an issue number.
  // Requiring both here means the register cannot lose the half that makes
  // the other half unambiguous.
  "openmls/openmls#2163",
  "openmls/openmls#2188",
  "rs/deny.toml",
  // 5. z/ submodule policy.
  "langchain/zcash/store.py",
  "z/zcash/zcash",
  "z/hhanh00/warp",
  "z/hhanh00/zwallet",
];

const VERIFIED_MARKER = /<!--\s*verified:\s*(\d{4}-\d{2}-\d{2})\s*-->/;

// ---------------------------------------------------------------------------
// Parsing. Line-oriented, matching the other check scripts in this repository:
// the alternative is a dependency, and these files are written in a plain
// subset that this reads exactly.
// ---------------------------------------------------------------------------

/// `.gitmodules` as `[{ name, path, url, branch }]`.
export function parseGitmodules(text) {
  const entries = [];
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = /^\[submodule "(.+)"\]$/.exec(line);
    if (header) {
      current = { name: header[1], path: null, url: null, branch: null };
      entries.push(current);
      continue;
    }
    if (!current || line.startsWith("#")) continue;
    const pair = /^([a-zA-Z]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const [, key, value] = pair;
    if (key in current) current[key] = value.trim();
  }
  return entries;
}

/// The `[patch.crates-io]` entries of one manifest, as
/// `[{ crate, git, rev, branch }]`. Absent section yields `[]`.
export function parsePatchSection(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === "[patch.crates-io]");
  if (start < 0) return [];
  const patches = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith("[")) break;
    if (!line || line.startsWith("#")) continue;
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const [, crate, value] = pair;
    patches.push({
      crate,
      git: /git\s*=\s*"([^"]+)"/.exec(value)?.[1] ?? null,
      rev: /rev\s*=\s*"([^"]+)"/.exec(value)?.[1] ?? null,
      branch: /branch\s*=\s*"([^"]+)"/.exec(value)?.[1] ?? null,
    });
  }
  return patches;
}

/// The version requirement each crate carries in one dependency table —
/// `[workspace.dependencies]` for a workspace root, plain `[dependencies]` for
/// a standalone crate like `zcash_note_encryption`. Continuation lines are
/// joined on brace balance so a multi-line entry is read whole rather than half.
export function parseDependencyTable(text, table = "workspace.dependencies") {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `[${table}]`);
  if (start < 0) return new Map();
  const versions = new Map();
  let buffer = "";
  let depth = 0;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (depth === 0 && line.trimStart().startsWith("[")) break;
    const code = withoutComment(line);
    buffer += (buffer ? "\n" : "") + code;
    for (const character of code) {
      if (character === "{" || character === "[") depth += 1;
      if (character === "}" || character === "]") depth -= 1;
    }
    if (depth > 0) continue;
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*([\s\S]+)$/.exec(buffer.trim());
    buffer = "";
    depth = 0;
    if (!pair) continue;
    const [, crate, value] = pair;
    const inline = /^"([^"]+)"\s*$/.exec(value.trim());
    versions.set(
      crate,
      inline ? inline[1] : (/version\s*=\s*"([^"]+)"/.exec(value)?.[1] ?? null),
    );
  }
  return versions;
}

/// One entry per `[[package]]` block of a `Cargo.lock`, as
/// `{ name, version, dependencies }`. `dependencies` are the raw strings Cargo
/// writes: bare `"serde"` when the graph carries one copy, `"getrandom 0.3.4"`
/// when it carries several — which is the whole reason a lockfile can settle
/// *which* copy a package resolved to.
export function parseLockPackages(text) {
  const packages = [];
  let current = null;
  let inDependencies = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "[[package]]") {
      current = { name: null, version: null, dependencies: [] };
      packages.push(current);
      inDependencies = false;
      continue;
    }
    // `[metadata]` and any other table ends the package blocks.
    if (line.startsWith("[") && !inDependencies) {
      current = null;
      continue;
    }
    if (!current) continue;
    if (inDependencies) {
      if (line === "]") {
        inDependencies = false;
        continue;
      }
      const entry = /^"([^"]+)",?$/.exec(line);
      if (entry) current.dependencies.push(entry[1]);
      continue;
    }
    if (line === "dependencies = [") {
      inDependencies = true;
      continue;
    }
    const pair = /^(name|version)\s*=\s*"([^"]+)"$/.exec(line);
    if (pair) current[pair[1]] = pair[2];
  }
  return packages.filter((entry) => entry.name && entry.version);
}

/// Section 3's table, as `[{ crate, held, line }]`. Read back out of the page
/// so the register and `HOLDS` can be required to agree row for row: a row
/// added to the page with no registered constraint source is a claim nobody
/// re-reads, which is the failure this whole file exists to make impossible.
export function parseHoldTable(register) {
  const lines = register.split("\n");
  const start = lines.findIndex((line) => /^##\s+3\./.test(line));
  if (start < 0) return [];
  const rows = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s/.test(line)) break;
    const row = /^\|\s*`([A-Za-z0-9_-]+)`\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (row) rows.push({ crate: row[1], held: row[2], line });
  }
  return rows;
}

/// The English a measurement is written as, so the sentence a reader sees and
/// the number the checker read cannot drift apart. Deriving the phrase rather
/// than hand-listing it is the point: a row carrying `rowClaim` must contain
/// this string, and the only way to change the string is to change the
/// measurement it came from.
export function claimText(item, crate) {
  if (item.kind === "copies") {
    const versions = lockCopies(
      item.versions.map((version) => ({ name: crate, version })),
      crate,
    );
    if (versions.length < 2) return versions[0] ?? null;
    return `${versions.slice(0, -1).join(", ")} and ${versions.at(-1)}`;
  }
  if (item.kind === "consumers") {
    return `${item.count} package${item.count === 1 ? "" : "s"}`;
  }
  return null;
}

/// Does a resolved version sit on the caret line the register claims? `0.3.4`
/// is on `0.3`; `0.4.3` is not. Held lines are written the way Cargo writes a
/// requirement, so the comparison is a prefix one and deliberately literal.
export function onHeldLine(version, held) {
  const bare = String(held).replace(/^[=^~><]+/, "");
  return version === bare || version.startsWith(`${bare}.`);
}

/// Every resolved version of one crate in one parsed lockfile, in version
/// order, so the comparison against a registered set is order-insensitive and
/// the failure message reads the way a human would list them (`0.8.7` before
/// `0.10.2`, which a lexicographic sort gets backwards).
export function lockCopies(packages, crate) {
  const parts = (version) =>
    version.split(/[.+-]/).map((piece) => Number.parseInt(piece, 10) || 0);
  return packages
    .filter((entry) => entry.name === crate)
    .map((entry) => entry.version)
    .sort((left, right) => {
      const a = parts(left);
      const b = parts(right);
      for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const diff = (a[index] ?? 0) - (b[index] ?? 0);
        if (diff) return diff;
      }
      return 0;
    });
}

/// Which copy of `crate` did `pkg` resolve to? Cargo writes a bare `"serde"`
/// when the graph carries one copy and `"getrandom 0.3.4"` when it carries
/// several, so the bare form has to be resolved through the package list or the
/// claim is not actually checked.
export function resolvedEdge(packages, pkg, crate) {
  const edge = pkg.dependencies.find(
    (entry) => entry === crate || entry.startsWith(`${crate} `),
  );
  if (!edge) return null;
  if (edge !== crate) return edge.slice(crate.length + 1);
  const copies = lockCopies(packages, crate);
  return copies.length === 1 ? copies[0] : null;
}

function ownerOf(url) {
  return /github\.com[/:]([^/]+)\//.exec(url)?.[1] ?? null;
}

/// Strip a TOML line comment without eating a `#` that lives inside a string.
function withoutComment(line) {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && line[index - 1] !== "\\") quoted = !quoted;
    if (character === "#" && !quoted) return line.slice(0, index);
  }
  return line;
}

/// Compare two dotted version requirements numerically, ignoring any `=`/`^`
/// operator and treating a pre-release suffix as lower than the release. Enough
/// for "is the published stable version at least X", which is all it is used for.
export function atLeast(candidate, floor) {
  const parse = (value) => {
    const [core, pre] = String(value).replace(/^[=^~><]+/, "").split("-");
    return {
      parts: core.split(".").map((piece) => Number.parseInt(piece, 10) || 0),
      pre: pre ?? null,
    };
  };
  const left = parse(candidate);
  const right = parse(floor);
  for (let index = 0; index < 3; index += 1) {
    const a = left.parts[index] ?? 0;
    const b = right.parts[index] ?? 0;
    if (a !== b) return a > b;
  }
  if (left.pre && !right.pre) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Offline verdict.
// ---------------------------------------------------------------------------

/// `snapshot` is `{ gitmodules, register, manifests, sources }`, where
/// `manifests` maps every tracked `Cargo.toml` path to its contents and
/// `sources` maps every constraint source a hold names — a `z/` manifest or a
/// `Cargo.lock` — to its contents. Taking a snapshot rather than reading files
/// here is what lets the self-test mutate one input at a time and watch this
/// fail.
export function offlineFailures(snapshot) {
  const failures = [];
  const submodules = parseGitmodules(snapshot.gitmodules);

  if (submodules.length === 0) {
    failures.push(".gitmodules declares no submodules");
  }
  for (const submodule of submodules) {
    if (!submodule.url) {
      failures.push(`${submodule.name}: .gitmodules entry has no url`);
    }
    // The z3 failure mode starts here: an entry with no `branch` cannot be
    // resolved by `git submodule update --remote` either.
    if (!submodule.branch) {
      failures.push(
        `${submodule.name}: .gitmodules entry declares no branch, so ` +
          "`git submodule update --remote` cannot resolve it",
      );
    }
  }

  // Forks must be registered, in both directions.
  const registeredSubmodules = new Map(
    TRACKED.filter((entry) => entry.kind === "submodule").map((entry) => [
      entry.id,
      entry,
    ]),
  );
  for (const submodule of submodules) {
    if (!submodule.url || !FORK_OWNERS.has(ownerOf(submodule.url))) continue;
    const tracked = registeredSubmodules.get(submodule.path ?? submodule.name);
    if (!tracked) {
      failures.push(
        `${submodule.path ?? submodule.name}: points at a fork we control ` +
          `(${submodule.url}) and is not in ${REGISTER_PATH}'s registry`,
      );
      continue;
    }
    if (submodule.url !== tracked.forkUrl) {
      failures.push(
        `${tracked.id}: registered fork url ${tracked.forkUrl}, .gitmodules says ${submodule.url}`,
      );
    }
    if (submodule.branch !== tracked.forkBranch) {
      failures.push(
        `${tracked.id}: registered fork branch ${tracked.forkBranch}, .gitmodules says ${submodule.branch}`,
      );
    }
  }
  for (const tracked of registeredSubmodules.values()) {
    const present = submodules.some(
      (submodule) => (submodule.path ?? submodule.name) === tracked.id,
    );
    if (!present) {
      failures.push(
        `${tracked.id}: registered as a fork but absent from .gitmodules — ` +
          "retire the register entry when the fork goes",
      );
    }
  }

  // `[patch.crates-io]` must be registered, pinned by rev, and confined to the
  // manifests that are allowed one.
  const registeredPatches = new Map(
    TRACKED.filter((entry) => entry.kind === "patch").map((entry) => [
      `${entry.manifest}#${entry.id}`,
      entry,
    ]),
  );
  const seenPatches = new Set();
  for (const [manifestPath, contents] of Object.entries(snapshot.manifests)) {
    const patches = parsePatchSection(contents);
    if (patches.length && !PATCHABLE_MANIFESTS.includes(manifestPath)) {
      failures.push(
        `${manifestPath}: carries [patch.crates-io] and is not a registered patch site`,
      );
      continue;
    }
    for (const patch of patches) {
      const key = `${manifestPath}#${patch.crate}`;
      seenPatches.add(key);
      const tracked = registeredPatches.get(key);
      if (!tracked) {
        failures.push(
          `${key}: [patch.crates-io] entry is not in ${REGISTER_PATH}'s registry`,
        );
        continue;
      }
      // A moving branch is not a reproducible build and `--locked` has to mean
      // something, so `rev` is the only accepted pin.
      if (patch.branch || !patch.rev) {
        failures.push(
          `${key}: [patch.crates-io] must be pinned by rev, never by branch`,
        );
      }
      if (patch.rev && patch.rev !== tracked.forkRev) {
        failures.push(
          `${key}: registered rev ${tracked.forkRev}, manifest says ${patch.rev}`,
        );
      }
      if (patch.git && patch.git !== tracked.forkUrl) {
        failures.push(
          `${key}: registered fork url ${tracked.forkUrl}, manifest says ${patch.git}`,
        );
      }
    }
  }
  for (const [key, tracked] of registeredPatches) {
    if (!seenPatches.has(key)) {
      failures.push(
        `${key}: registered as a patch but absent from ${tracked.manifest} — ` +
          "retire the register entry when the patch goes",
      );
    }
  }

  // Section 3: every hold, re-read from the source that row names.
  //
  // Each source is parsed once, and a source that came back empty is reported
  // once rather than as one failure per hold that names it — an un-checked-out
  // submodule is a single fact.
  const tables = new Map();
  for (const hold of HOLDS) {
    if (hold.source.kind !== "manifest") continue;
    const key = `${hold.source.path}#${hold.source.table}`;
    if (tables.has(key)) continue;
    tables.set(
      key,
      parseDependencyTable(
        snapshot.sources[hold.source.path] ?? "",
        hold.source.table,
      ),
    );
  }
  const emptySources = new Set();
  for (const [key, table] of tables) {
    if (table.size) continue;
    const [sourcePath, tableName] = key.split("#");
    emptySources.add(sourcePath);
    failures.push(
      `${sourcePath}: no [${tableName}] found — is the submodule checked out? ` +
        `(git submodule update --init ${path.dirname(sourcePath)})`,
    );
  }

  const locks = new Map();
  const lockPaths = new Set(
    HOLDS.flatMap((hold) => [
      hold.source.kind === "lockfile" ? hold.source.path : null,
      ...(hold.evidence ?? []).map((item) => item.path),
    ]).filter(Boolean),
  );
  const emptyLocks = new Set();
  for (const lockPath of lockPaths) {
    const packages = parseLockPackages(snapshot.sources[lockPath] ?? "");
    locks.set(lockPath, packages);
    if (packages.length) continue;
    emptyLocks.add(lockPath);
    failures.push(
      `${lockPath}: no [[package]] entries found — a lockfile a hold is ` +
        "verified against is missing or unreadable",
    );
  }

  for (const hold of HOLDS) {
    const { crate, held, source } = hold;

    if (source.kind === "manifest") {
      if (emptySources.has(source.path)) continue;
      const actual = tables.get(`${source.path}#${source.table}`).get(crate);
      if (actual === undefined) {
        failures.push(
          `${crate}: register says ${source.path} forces ${source.requires}, ` +
            `but its [${source.table}] declares no such dependency any more`,
        );
      } else if (actual !== source.requires) {
        failures.push(
          `${crate}: register says ${source.path} forces ${source.requires}, ` +
            `it now declares ${actual} — the hold's stated justification is stale`,
        );
      }
      continue;
    }

    if (source.kind === "lockfile") {
      if (emptyLocks.has(source.path)) continue;
      const packages = locks.get(source.path);
      const named = packages.filter((entry) => entry.name === source.forcedBy.name);
      const forcing = named.find(
        (entry) => entry.version === source.forcedBy.version,
      );
      if (!forcing) {
        failures.push(
          `${crate}: register says ${source.forcedBy.name} ${source.forcedBy.version} ` +
            `forces ${held}, but ${source.path} resolves ${source.forcedBy.name} to ` +
            `${named.map((entry) => entry.version).join(", ") || "nothing"} — ` +
            "re-read that crate's own manifest and re-verify the row",
        );
        continue;
      }
      const resolved = resolvedEdge(packages, forcing, crate);
      if (resolved === null) {
        failures.push(
          `${crate}: register says ${source.forcedBy.name} ${source.forcedBy.version} ` +
            `forces ${held}, but ${source.path} shows it no longer depends on ${crate} — ` +
            "the hold has lost the thing that forced it",
        );
      } else if (!onHeldLine(resolved, held)) {
        failures.push(
          `${crate}: register says ${source.forcedBy.name} ${source.forcedBy.version} ` +
            `forces ${held}, but ${source.path} resolves that edge to ${resolved}`,
        );
      }
      continue;
    }

    if (source.kind === "ours") {
      // The negative claim, against every registered upstream source.
      for (const [key, table] of tables) {
        const [sourcePath, tableName] = key.split("#");
        if (emptySources.has(sourcePath) || !table.has(crate)) continue;
        failures.push(
          `${crate}: register calls this hold our own choice, but ${sourcePath}'s ` +
            `[${tableName}] now declares ${table.get(crate)} — re-attribute it`,
        );
      }
    }
  }

  // The measured consequences. A row may say "ours is the only copy" or "the
  // lock carries 0.8 and 0.10"; those are claims too, and this is what re-reads
  // them. Without it, §3's `rand` row can go on saying "0.8, 0.9 and 0.10"
  // months after the 0.9 island is gone, which is exactly what happened.
  for (const hold of HOLDS) {
    for (const item of hold.evidence ?? []) {
      if (emptyLocks.has(item.path)) continue;
      const packages = locks.get(item.path);
      const crate = item.crate ?? hold.crate;

      if (item.kind === "copies") {
        const found = lockCopies(packages, crate);
        const expected = lockCopies(
          item.versions.map((version) => ({ name: crate, version })),
          crate,
        );
        if (found.join(", ") !== expected.join(", ")) {
          failures.push(
            `${hold.crate}: the register's measured claim is that ${item.path} ` +
              `carries ${crate} ${expected.join(" and ") || "nothing"}, it now ` +
              `carries ${found.join(" and ") || "nothing"} — re-measure the row`,
          );
        }
        continue;
      }

      if (item.kind === "consumers") {
        const found = packages.filter((entry) => {
          const resolved = resolvedEdge(packages, entry, crate);
          return resolved !== null && onHeldLine(resolved, item.on);
        }).length;
        if (found !== item.count) {
          failures.push(
            `${hold.crate}: the register says ${item.count} package(s) resolve ` +
              `${crate} on ${item.on} in ${item.path}, it is now ${found} — ` +
              "re-measure the row",
          );
        }
        continue;
      }

      // `edge`: a named package still resolves the crate on a named line, which
      // is how "they all share this copy" stops being an unread assertion.
      // `from.version` is required wherever the graph carries more than one
      // copy of the naming package, or the edge read would depend on lockfile
      // ordering rather than on the fact being asserted.
      const named = `${item.from.name}${item.from.version ? ` ${item.from.version}` : ""}`;
      const pkg = packages.find(
        (entry) =>
          entry.name === item.from.name &&
          (!item.from.version || entry.version === item.from.version),
      );
      if (!pkg) {
        failures.push(
          `${hold.crate}: the register's measured claim names ${named} ` +
            `as sharing ${crate} ${item.on}, but ${item.path} no longer resolves ` +
            `${named} at all`,
        );
        continue;
      }
      if (
        !item.from.version &&
        packages.filter((entry) => entry.name === item.from.name).length > 1
      ) {
        failures.push(
          `${hold.crate}: ${item.path} now carries more than one ${item.from.name}, ` +
            "so this edge no longer names a single package — pin the claim to a version",
        );
        continue;
      }
      const resolved = resolvedEdge(packages, pkg, crate);
      if (resolved === null || !onHeldLine(resolved, item.on)) {
        failures.push(
          `${hold.crate}: the register's measured claim is that ${named} ` +
            `resolves ${crate} on ${item.on} in ${item.path}, it now resolves ` +
            `${resolved ?? "no such dependency"}`,
        );
      }
    }
  }

  // Section 3's table and `HOLDS` must agree row for row, in both directions.
  // The forward direction stops a hold being dropped from the page while the
  // version is still pinned; the reverse stops a row being *added* to the page
  // with no source anything re-reads, which is the shape of every claim that
  // rotted here before.
  const tableRows = parseHoldTable(snapshot.register);
  const expectedRows = new Map(
    HOLDS.filter((hold) => hold.registerRow !== false).map((hold) => [
      hold.crate,
      hold,
    ]),
  );
  for (const row of tableRows) {
    const hold = expectedRows.get(row.crate);
    if (!hold) {
      failures.push(
        `${REGISTER_PATH}: section 3 lists \`${row.crate}\` (${row.held}) but no ` +
          "hold in check-dependency-register.mjs names a source for it — a row " +
          "nothing re-reads is worse than no row",
      );
      continue;
    }
    if (row.held !== hold.held) {
      failures.push(
        `${REGISTER_PATH}: section 3 says \`${row.crate}\` is held at ${row.held}, ` +
          `the registry says ${hold.held}`,
      );
    }
    if (hold.registerToken && !row.line.includes(hold.registerToken)) {
      failures.push(
        `${REGISTER_PATH}: the \`${row.crate}\` row does not name \`${hold.registerToken}\`, ` +
          "the source this check actually re-reads — the row must point at what verifies it",
      );
    }
    // A measurement is only re-read if the SENTENCE carries the number the
    // check read. Verifying the lock and letting the prose say something else
    // is how §3's `rand` row stayed wrong through a green check.
    for (const item of hold.evidence ?? []) {
      if (!item.rowClaim) continue;
      const claim = claimText(item, item.crate ?? hold.crate);
      if (claim && !row.line.includes(claim)) {
        failures.push(
          `${REGISTER_PATH}: the \`${row.crate}\` row states a measurement this check ` +
            `re-reads, but does not say "${claim}" — the sentence a reader sees must ` +
            "carry the number that was measured",
        );
      }
    }
  }
  for (const crate of expectedRows.keys()) {
    if (!tableRows.some((row) => row.crate === crate)) {
      failures.push(
        `${REGISTER_PATH}: section 3's table has lost the \`${crate}\` hold`,
      );
    }
  }
  // `sectionClaim` is the same rule for a measurement stated in section 3's
  // prose rather than in a table row — the `sha2` correction's counts live in a
  // paragraph, and a paragraph rots exactly as quietly as a cell.
  for (const hold of HOLDS) {
    for (const item of hold.evidence ?? []) {
      if (!item.sectionClaim) continue;
      const claim = claimText(item, item.crate ?? hold.crate);
      if (claim && !snapshot.register.includes(claim)) {
        failures.push(
          `${REGISTER_PATH}: section 3 explains the \`${hold.crate}\` hold with a ` +
            `measurement this check re-reads, but no longer says "${claim}"`,
        );
      }
    }
  }

  // The register itself.
  const register = snapshot.register;
  const marker = VERIFIED_MARKER.exec(register);
  if (!marker) {
    failures.push(
      `${REGISTER_PATH}: missing its <!-- verified: YYYY-MM-DD --> marker`,
    );
  } else if (Number.isNaN(Date.parse(`${marker[1]}T00:00:00Z`))) {
    failures.push(`${REGISTER_PATH}: verified marker ${marker[1]} is not a date`);
  }
  const requiredTokens = [
    ...TRACKED.flatMap((entry) => [entry.id, ...entry.registerTokens]),
    ...NARRATIVE_TOKENS,
  ];
  for (const token of requiredTokens) {
    if (!register.includes(token)) {
      failures.push(`${REGISTER_PATH}: does not mention \`${token}\``);
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Upstream verdict. Network, and therefore never a required check.
// ---------------------------------------------------------------------------

async function githubJson(route) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "free2z-zuu-dependency-register",
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/${route}`, { headers });
  if (!response.ok) {
    throw new Error(`GET ${route} -> ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function cratesIo(name) {
  const response = await fetch(`https://crates.io/api/v1/crates/${name}`, {
    headers: { "user-agent": "free2z-zuu-dependency-register" },
  });
  if (!response.ok) {
    throw new Error(`crates.io ${name} -> ${response.status}`);
  }
  return response.json();
}

function remoteHasBranch(url, branch) {
  const output = execFileSync(
    "git",
    ["ls-remote", "--heads", url, `refs/heads/${branch}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return output.trim().length > 0;
}

/// Findings are `{ severity, headline, detail }`. `severity: "exit"` means an
/// exit condition has fired and the fork should be retired — the good outcome,
/// reported loudly rather than as a failure of ours.
export async function upstreamFindings(snapshot, deps = {}) {
  const api = deps.githubJson ?? githubJson;
  const registry = deps.cratesIo ?? cratesIo;
  const lsRemote = deps.remoteHasBranch ?? remoteHasBranch;
  const today = deps.today ?? new Date();
  const findings = [];
  const note = (severity, headline, detail) =>
    findings.push({ severity, headline, detail });

  // 1. `.gitmodules` branches that do not exist on their remote. The cheapest
  //    of the three rules, and the one that would have caught z3.
  for (const submodule of parseGitmodules(snapshot.gitmodules)) {
    if (!submodule.url || !submodule.branch) continue;
    let exists;
    try {
      exists = lsRemote(submodule.url, submodule.branch);
    } catch (error) {
      note(
        "unknown",
        `${submodule.path ?? submodule.name}: could not reach ${submodule.url}`,
        String(error.message ?? error),
      );
      continue;
    }
    if (!exists) {
      note(
        "drift",
        `${submodule.path ?? submodule.name}: .gitmodules branch \`${submodule.branch}\` does not exist on ${submodule.url}`,
        "`git submodule update --remote` cannot resolve this submodule at all. " +
          "Upstream probably renamed or deleted the branch; point `.gitmodules` at the new one.",
      );
    }
  }

  for (const tracked of TRACKED) {
    // 2. Exit conditions.
    if (tracked.exitPr) {
      // RESOLVE VIA `/issues/{n}`, NEVER `/pulls/{n}`.
      //
      // On GitHub every pull request is also an issue, but not every issue is
      // a pull request — and `/pulls/{n}` returns a bare 404 for an issue
      // number. That 404 would surface here as a thrown error and exit 2,
      // which dependency-register.yml reads as "the script or the network
      // broke" rather than "someone registered an issue number". A wrong
      // registration would then look exactly like an api.github.com outage.
      //
      // This is not hypothetical: the openmls defect tracked in section 4 of
      // the register is issue #2188, fixed by pull request #2163, and
      // confusing the two is what `/pulls/2188` 404ing already caused once.
      // `/issues/{n}` resolves both shapes, and the `pull_request` key is what
      // distinguishes them.
      const reference = `${tracked.upstreamRepo}#${tracked.exitPr}`;
      const issue = await api(
        `repos/${tracked.upstreamRepo}/issues/${tracked.exitPr}`,
      );
      const isPullRequest = issue.pull_request != null;
      if (!isPullRequest) {
        // An issue closing says the maintainers consider it handled; it does
        // not say a release carries the fix, which is what retires a pin. So
        // this is a finding about the *registration*, not about upstream.
        note(
          "drift",
          `${tracked.id}: registered exit reference ${reference} is an issue, not a pull request`,
          "An issue's state does not tell you whether the fix shipped. Register the pull " +
            "request that closes it, so `merged` is the signal.",
        );
      } else if (issue.pull_request.merged_at) {
        note(
          "exit",
          `${tracked.id}: ${reference} MERGED (${issue.pull_request.merged_at}) — drop the fork`,
          `Move the submodule back to https://github.com/${tracked.upstreamRepo} + \`${tracked.upstreamBranch}\`, ` +
            `drop the pin, and retire section for \`${tracked.id}\` in ${REGISTER_PATH}.`,
        );
      } else if (issue.state === "closed") {
        note(
          "drift",
          `${tracked.id}: ${reference} was CLOSED without merging`,
          "The exit condition can never fire. Either reopen it upstream or the fork needs a new plan.",
        );
      }

      // Upstream gates fork-PR workflows behind maintainer approval, so this
      // is expected to be zero. It is recorded rather than asserted: the point
      // is that "wait for green upstream" is not a signal available here.
      //
      // Only a pull request has a head commit to ask about.
      if (isPullRequest) {
        const pull = await api(
          `repos/${tracked.upstreamRepo}/pulls/${tracked.exitPr}`,
        );
        const checks = await api(
          `repos/${tracked.upstreamRepo}/commits/${pull.head.sha}/check-runs`,
        );
        if (checks.total_count === 0) {
          note(
            "info",
            `${tracked.id}: upstream has still run no CI on ${reference}`,
            "`check-runs` total_count is 0. Our own `gate` / `rs / gate` remain the only evidence.",
          );
        }
      }
    }
    if (tracked.exitCrate) {
      const crate = await registry(tracked.exitCrate.name);
      const stable = crate.crate.max_stable_version;
      if (stable && atLeast(stable, tracked.exitCrate.stableAtLeast)) {
        note(
          "exit",
          `${tracked.id}: crates.io now publishes ${tracked.exitCrate.name} ${stable}`,
          `The register expects the patch to retire once a real ${tracked.exitCrate.name} ` +
            `${tracked.exitCrate.stableAtLeast} exists. Re-read the second half of the exit ` +
            "condition (the Zcash stack's secp256k1 version) before dropping the patch.",
        );
      }
    }
    if (tracked.exitDependencyMove) {
      const workspace = parseDependencyTable(
        snapshot.sources[LIBRUSTZCASH_MANIFEST] ?? "",
      );
      const actual = workspace.get(tracked.exitDependencyMove.crate);
      if (actual && actual !== tracked.exitDependencyMove.awayFrom) {
        note(
          "exit",
          `${tracked.id}: librustzcash moved ${tracked.exitDependencyMove.crate} to ${actual}`,
          "That is the second half of this patch's exit condition. Check the first half " +
            "(a real bip32 0.6.0 on crates.io) and drop the patch when both hold.",
        );
      }
    }

    // 3. Drift behind the upstream base.
    const head = tracked.forkRev ?? tracked.forkBranch;
    const forkRepo = tracked.forkUrl.replace("https://github.com/", "");
    const [forkOwner, forkName] = forkRepo.split("/");
    const comparison = await api(
      `repos/${tracked.upstreamRepo}/compare/${encodeURIComponent(tracked.upstreamBranch)}...${forkOwner}:${forkName}:${encodeURIComponent(head)}`,
    );
    if (comparison.behind_by > tracked.driftLimit) {
      note(
        "drift",
        `${tracked.id}: fork is ${comparison.behind_by} commits behind ${tracked.upstreamRepo}@${tracked.upstreamBranch} (limit ${tracked.driftLimit})`,
        "Rebase the fork forward onto upstream `main` — a bridge that stops moving is a parking spot.",
      );
    }

    // 4. A fork whose PR head is a different branch can silently diverge from
    //    the branch we actually build. This is exactly the trap #852 hit.
    if (tracked.prHeadBranch) {
      const built = await api(
        `repos/${forkRepo}/branches/${encodeURIComponent(tracked.forkBranch)}`,
      );
      const reviewed = await api(
        `repos/${forkRepo}/branches/${encodeURIComponent(tracked.prHeadBranch)}`,
      );
      if (built.commit.sha !== reviewed.commit.sha) {
        note(
          "drift",
          `${tracked.id}: the branch we build and the branch upstream reviews have diverged`,
          `\`${tracked.forkBranch}\` is at ${built.commit.sha.slice(0, 10)}, ` +
            `\`${tracked.prHeadBranch}\` (the head of ${tracked.upstreamRepo}#${tracked.exitPr}) ` +
            `is at ${reviewed.commit.sha.slice(0, 10)}. Rebase both or upstream is reviewing something else.`,
        );
      }
    }
  }

  // 5. Register staleness. Time alone must never fail a pull request, so this
  //    lives only in the scheduled half.
  const marker = VERIFIED_MARKER.exec(snapshot.register);
  if (marker) {
    const age = Math.floor(
      (today.getTime() - Date.parse(`${marker[1]}T00:00:00Z`)) / 86_400_000,
    );
    if (age > REGISTER_MAX_AGE_DAYS) {
      note(
        "drift",
        `${REGISTER_PATH}: last verified ${marker[1]}, ${age} days ago`,
        `Re-verify every row against its live source and move the marker. ` +
          `A register of unverified restatements is worse than no register.`,
      );
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Snapshots and CLI.
// ---------------------------------------------------------------------------

function read(relative) {
  const absolute = path.join(REPO_ROOT, relative);
  return fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";
}

function trackedManifests() {
  const output = execFileSync("git", ["ls-files", "--", "*Cargo.toml"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return output.split("\n").filter(Boolean);
}

export function liveSnapshot() {
  const manifests = {};
  for (const manifest of trackedManifests()) {
    manifests[manifest] = read(manifest);
  }
  const sources = {};
  for (const sourcePath of HOLD_SOURCE_PATHS) {
    sources[sourcePath] = read(sourcePath);
  }
  return {
    gitmodules: read(GITMODULES_PATH),
    register: read(REGISTER_PATH),
    manifests,
    sources,
  };
}

function requireFailure(name, snapshot, expected) {
  const failures = offlineFailures(snapshot);
  if (!failures.some((failure) => failure.includes(expected))) {
    throw new Error(
      `mutation escaped policy: ${name}\n  expected a failure containing: ${expected}\n  got: ${JSON.stringify(failures, null, 2)}`,
    );
  }
}

function runSelfTest() {
  const baseline = liveSnapshot();
  const clean = offlineFailures(baseline);
  if (clean.length) {
    throw new Error(
      `self-test needs a passing baseline, got:\n${clean.map((f) => `  - ${f}`).join("\n")}`,
    );
  }

  const withGitmodules = (text) => ({ ...baseline, gitmodules: text });
  const withRegister = (text) => ({ ...baseline, register: text });
  const withSource = (relative, text) => ({
    ...baseline,
    sources: { ...baseline.sources, [relative]: text },
  });
  const editSource = (relative, from, to) =>
    withSource(relative, baseline.sources[relative].replace(from, to));
  const withLibrustzcash = (text) => withSource(LIBRUSTZCASH_MANIFEST, text);
  const withManifest = (relative, text) => ({
    ...baseline,
    manifests: { ...baseline.manifests, [relative]: text },
  });

  const cases = [
    [
      "a .gitmodules branch field is deleted (the z3 failure mode's precursor)",
      withGitmodules(
        baseline.gitmodules.replace("\tbranch = main\n", "", 1),
      ),
      "declares no branch",
    ],
    [
      "the fork submodule quietly moves to another branch",
      withGitmodules(
        baseline.gitmodules.replace(
          "branch = f2z/drop-stale-rustcrypto-rc-pins",
          "branch = f2z/some-other-branch",
        ),
      ),
      "registered fork branch f2z/drop-stale-rustcrypto-rc-pins",
    ],
    [
      "a second, unregistered fork appears in z/",
      withGitmodules(
        `${baseline.gitmodules}\n[submodule "z/zcash/orchard-fork"]\n\tpath = z/zcash/orchard-fork\n\turl = https://github.com/free2z/orchard\n\tbranch = main\n`,
      ),
      "is not in docs/DEPENDENCIES.md's registry",
    ],
    [
      "the fork submodule is dropped but the register entry stays",
      withGitmodules(
        baseline.gitmodules.replace(
          'path = z/zcash/librustzcash',
          'path = z/zcash/librustzcash-renamed',
        ),
      ),
      "registered as a fork but absent from .gitmodules",
    ],
    [
      "the bip32 patch is re-pinned to a moving branch",
      withManifest(
        "wallet/zuuli/src-tauri/Cargo.toml",
        baseline.manifests["wallet/zuuli/src-tauri/Cargo.toml"].replace(
          'rev = "131d490ef75ccd23111cc7f3df91e4a88fc971ae"',
          'branch = "f2z/bip32-secp256k1-0.29"',
        ),
      ),
      "must be pinned by rev, never by branch",
    ],
    [
      "the bip32 patch rev drifts from the reviewed one",
      withManifest(
        "wallet/zuuli/src-tauri/Cargo.toml",
        baseline.manifests["wallet/zuuli/src-tauri/Cargo.toml"].replace(
          "131d490ef75ccd23111cc7f3df91e4a88fc971ae",
          "0000000000000000000000000000000000000000",
        ),
      ),
      "registered rev 131d490ef75ccd23111cc7f3df91e4a88fc971ae",
    ],
    [
      "the bip32 patch is deleted while the register still claims it",
      withManifest(
        "wallet/zuuli/src-tauri/Cargo.toml",
        baseline.manifests["wallet/zuuli/src-tauri/Cargo.toml"].replace(
          "[patch.crates-io]",
          "[patch.crates-io-disabled]",
        ),
      ),
      "registered as a patch but absent from",
    ],
    [
      "a patch section appears in a manifest that is not a registered patch site",
      withManifest(
        "wallet/zuuallet/src-tauri/Cargo.toml",
        `${baseline.manifests["wallet/zuuallet/src-tauri/Cargo.toml"]}\n[patch.crates-io]\nfoo = { git = "https://github.com/free2z/foo", rev = "deadbeef" }\n`,
      ),
      "is not a registered patch site",
    ],
    [
      "upstream librustzcash bumps a hold the register says it forces",
      editSource(
        LIBRUSTZCASH_MANIFEST,
        'rusqlite = { version = "0.37"',
        'rusqlite = { version = "0.38"',
      ),
      "it now declares 0.38",
    ],
    [
      "upstream librustzcash drops a hold the register says it forces",
      withLibrustzcash(
        baseline.sources[LIBRUSTZCASH_MANIFEST].replace(
          /^secrecy = "0\.8"$/m,
          "# secrecy gone",
        ),
      ),
      "declares no such dependency any more",
    ],
    [
      // One of the four holds #855's measurement surfaced. They are read the
      // same way `rusqlite` is, so one mutant covers the shape; what is new is
      // that they exist at all.
      "upstream librustzcash bumps one of the holds the graph measurement surfaced",
      editSource(
        LIBRUSTZCASH_MANIFEST,
        'ripemd = { version = "0.1"',
        'ripemd = { version = "0.2"',
      ),
      "ripemd: register says z/zcash/librustzcash/Cargo.toml forces 0.1",
    ],
    [
      "upstream takes a position on a hold the register calls our own",
      editSource(
        LIBRUSTZCASH_MANIFEST,
        'sha2 = { version = "0.10", default-features = false }',
        'sha2 = { version = "0.10", default-features = false }\nhkdf = { version = "0.13", default-features = false }',
      ),
      "register calls this hold our own choice",
    ],
    [
      "the librustzcash submodule is not checked out",
      withLibrustzcash(""),
      "is the submodule checked out?",
    ],

    // ---- Holds whose constraint source is NOT librustzcash. ----------------
    //
    // These are the rows that used to be unverifiable-but-verified-looking:
    // `chacha20poly1305` is `zcash_note_encryption`'s requirement and
    // `getrandom` is `tauri`'s, and neither is read by librustzcash's manifest.
    [
      "a hold's own upstream — not librustzcash — bumps it",
      editSource(
        NOTE_ENCRYPTION_MANIFEST,
        'chacha20poly1305 = { version = "0.10"',
        'chacha20poly1305 = { version = "0.11"',
      ),
      "chacha20poly1305: register says z/zcash/zcash_note_encryption/Cargo.toml forces 0.10",
    ],
    [
      "a hold's own upstream drops the dependency that forced it",
      editSource(
        NOTE_ENCRYPTION_MANIFEST,
        'chacha20poly1305 = { version = "0.10", default-features = false }',
        "# chacha20poly1305 gone",
      ),
      "declares no such dependency any more",
    ],
    [
      "the second constraint-source submodule is not checked out",
      withSource(NOTE_ENCRYPTION_MANIFEST, ""),
      "z/zcash/zcash_note_encryption/Cargo.toml: no [dependencies] found",
    ],
    [
      "a non-librustzcash upstream takes a position on the hold we call our own",
      editSource(
        NOTE_ENCRYPTION_MANIFEST,
        'subtle = { version = "2.3", default-features = false }',
        'subtle = { version = "2.3", default-features = false }\nhkdf = { version = "0.13", default-features = false }',
      ),
      "z/zcash/zcash_note_encryption/Cargo.toml's [dependencies] now declares 0.13",
    ],
    [
      // A tauri bump does not mean the hold is wrong — it means nobody has
      // re-read tauri's requirement since. Going red is the point.
      "the lockfile-verified hold's forcing crate moves off the version that was read",
      editSource(ZUULI_LOCK, 'name = "tauri"\nversion = "2.11.5"', 'name = "tauri"\nversion = "2.12.0"'),
      "resolves tauri to 2.12.0",
    ],
    [
      "the lockfile-verified hold's forcing crate stops depending on the held crate",
      editSource(ZUULI_LOCK, ' "getrandom 0.3.4",\n "glob",', ' "glob",'),
      "no longer depends on getrandom",
    ],
    [
      "the lockfile-verified hold's forcing crate resolves to another line",
      editSource(ZUULI_LOCK, ' "getrandom 0.3.4",\n "glob",', ' "getrandom 0.4.3",\n "glob",'),
      "resolves that edge to 0.4.3",
    ],
    [
      "the lockfile a hold is verified against is missing",
      withSource(ZUULI_LOCK, ""),
      "no [[package]] entries found",
    ],

    // ---- Measured consequences. -------------------------------------------
    //
    // §3's `rand` row said the shipping lock carried "0.8, 0.9 and 0.10" for as
    // long as it took a human to notice, because the check was reading
    // librustzcash's manifest — the right source for who forces the hold, and
    // no source at all for what the graph contains.
    [
      "the shipping lock regrows the rand island a row says is gone",
      editSource(
        ZUULI_LOCK,
        '[[package]]\nname = "rand"\nversion = "0.10.2"',
        '[[package]]\nname = "rand"\nversion = "0.9.2"\n\n[[package]]\nname = "rand"\nversion = "0.10.2"',
      ),
      "it now carries 0.8.7 and 0.9.2 and 0.10.2",
    ],
    [
      "bumping a hold adds the duplicate its row says it would",
      editSource(
        WALLET_LOCKS[0],
        '[[package]]\nname = "chacha20poly1305"\nversion = "0.10.1"',
        '[[package]]\nname = "chacha20poly1305"\nversion = "0.10.1"\n\n[[package]]\nname = "chacha20poly1305"\nversion = "0.11.0"',
      ),
      "wallet/plugins/tauri-plugin-zcash/Cargo.lock carries chacha20poly1305 0.10.1",
    ],
    [
      "a package the row says shares our copy moves off it",
      editSource(ZUULI_LOCK, ' "base64 0.22.1",\n "bech32",', ' "base64 0.23.1",\n "bech32",'),
      "zcash_client_backend resolves base64 on 0.22",
    ],
    [
      "a package the row names as sharing our copy leaves the graph",
      editSource(ZUULI_LOCK, 'name = "zip321"', 'name = "zip321-renamed"'),
      "no longer resolves zip321 at all",
    ],
    [
      // The `sha2` correction says 14 packages share 0.10 and 4 are on 0.11.
      // Counts are the most quietly-rotting kind of claim there is.
      "a consumer count the register states drifts",
      editSource(ZUULI_LOCK, ' "sha2 0.10.9",\n "zeroize",\n]', ' "zeroize",\n]'),
      "package(s) resolve sha2 on 0.10 in wallet/zuuli/src-tauri/Cargo.lock, it is now 13",
    ],
    [
      // Without `from.version`, an edge claim about a crate the graph carries
      // twice reads whichever copy Cargo happened to write first.
      "an edge claim stops naming a single package",
      editSource(
        ZUULI_LOCK,
        '[[package]]\nname = "zip321"',
        '[[package]]\nname = "zcash_script"\nversion = "0.9.9"\n\n[[package]]\nname = "zip321"',
      ),
      "now carries more than one zcash_script, so this edge no longer names a single package",
    ],
    [
      "the register loses its verification marker",
      withRegister(baseline.register.replace(VERIFIED_MARKER, "")),
      "missing its <!-- verified:",
    ],
    [
      "the register's verification marker is not a date",
      withRegister(
        baseline.register.replace(VERIFIED_MARKER, "<!-- verified: 2026-13-45 -->"),
      ),
      "is not a date",
    ],
    [
      "the register loses the exit condition for the librustzcash fork",
      withRegister(baseline.register.replaceAll("zcash/librustzcash#3010", "the PR")),
      "does not mention `zcash/librustzcash#3010`",
    ],
    [
      "the register forgets that #3010's head is a different branch",
      withRegister(
        baseline.register.replaceAll(
          "f2z/upstream-drop-stale-rustcrypto-rc-pins",
          "the other branch",
        ),
      ),
      "does not mention `f2z/upstream-drop-stale-rustcrypto-rc-pins`",
    ],
    [
      "the register drops a deliberate hold from section 3",
      withRegister(baseline.register.replace(/^\| `hkdf` \|.*$/m, "")),
      "section 3's table has lost the `hkdf` hold",
    ],
    [
      "the register changes the version a hold is held at",
      withRegister(baseline.register.replace("| `rand` | 0.8 |", "| `rand` | 0.9 |")),
      "section 3 says `rand` is held at 0.9",
    ],
    [
      // THE GAP THIS PR CLOSES. A row can be added to the page for a hold no
      // source verifies, and it looks exactly as checked as the ones that are.
      "a hold row is added to the register with no constraint source anything re-reads",
      withRegister(
        baseline.register.replace(
          "| `hkdf` | 0.12 |",
          "| `zeroize` | 1.8 | **Upstream, probably** | somewhere |\n| `hkdf` | 0.12 |",
        ),
      ),
      "no hold in check-dependency-register.mjs names a source for it",
    ],
    [
      "a hold row stops naming the source that verifies it",
      withRegister(
        baseline.register.replace(
          "z/zcash/zcash_note_encryption/Cargo.toml",
          "a note-encryption crate",
        ),
      ),
      "the `chacha20poly1305` row does not name",
    ],
    [
      "the lockfile-verified row stops naming the version whose requirement was read",
      withRegister(baseline.register.replaceAll("tauri 2.11.5", "tauri")),
      "the `getrandom` row does not name `tauri 2.11.5`",
    ],
    [
      // THE EXACT SHAPE OF THE `rand` BUG. The lock is right, the check reads
      // the lock, and the sentence a human reads still says something else.
      // Verifying the measurement without binding the prose to it would have
      // let this row go on being wrong through a green check.
      "a row's prose drifts from the measurement the check re-reads",
      withRegister(
        baseline.register.replace("**0.8.7 and 0.10.2 only**", "**0.8, 0.9 and 0.10**"),
      ),
      'the `rand` row states a measurement this check re-reads, but does not say "0.8.7 and 0.10.2"',
    ],
    [
      "a row's stated consumer count drifts from the measured one",
      withRegister(baseline.register.replace("shared by 5 packages", "shared by 4 packages")),
      'the `chacha20poly1305` row states a measurement this check re-reads, but does not say "5 packages"',
    ],
    [
      // The `sha2` correction's numbers live in a paragraph, not a cell, and a
      // paragraph rots exactly as quietly.
      "section 3's prose drifts from a measurement the check re-reads",
      withRegister(baseline.register.replace("14 packages resolve", "Most packages resolve")),
      'section 3 explains the `sha2` hold with a measurement this check re-reads, but no longer says "14 packages"',
    ],
    [
      "the register drops the openmls_memory_storage cross-reference",
      withRegister(baseline.register.replaceAll("openmls/openmls#2163", "an upstream PR")),
      "does not mention `openmls/openmls#2163`",
    ],
    [
      "the register drops the langchain consumer of z/",
      withRegister(baseline.register.replaceAll("langchain/zcash/store.py", "a script")),
      "does not mention `langchain/zcash/store.py`",
    ],
  ];

  for (const [name, snapshot, expected] of cases) {
    requireFailure(name, snapshot, expected);
  }
  process.stdout.write(
    `self-test: killed ${cases.length} offline dependency-register mutants.\n`,
  );
  return cases.length;
}

/// Negative controls for the network half, with github.com and crates.io
/// injected. Without these the three rules that actually matter — an exit
/// condition firing, a fork drifting, a `.gitmodules` branch vanishing — would
/// be untested code that only ever runs weekly, which is the same class of
/// unwatched thing this script exists to catch.
async function runUpstreamSelfTest() {
  const baseline = liveSnapshot();
  /// Every reply an unremarkable week produces: PR open, no upstream CI, fork
  /// level with its base, both fork branches at one commit, every remote branch
  /// present.
  ///
  /// `/issues/{n}` carries a `pull_request` object, which is how GitHub marks
  /// an issue that is also a pull request — the distinction the resolution
  /// above depends on, so the fake has to reproduce it rather than flatten it.
  const quiet = () => ({
    githubJson: async (route) => {
      if (/\/issues\/\d+$/.test(route)) {
        return {
          state: "open",
          pull_request: { merged_at: null },
        };
      }
      if (/\/pulls\/\d+$/.test(route)) {
        return { head: { sha: "a".repeat(40) } };
      }
      if (route.endsWith("/check-runs")) return { total_count: 4 };
      if (route.includes("/compare/")) {
        return { status: "ahead", ahead_by: 1, behind_by: 0 };
      }
      if (route.includes("/branches/")) return { commit: { sha: "b".repeat(40) } };
      throw new Error(`unexpected route ${route}`);
    },
    cratesIo: async () => ({ crate: { max_stable_version: "0.5.3" } }),
    remoteHasBranch: () => true,
    today: new Date("2026-08-31T00:00:00Z"),
  });

  const expectQuiet = async () => {
    const findings = await upstreamFindings(baseline, quiet());
    const actionable = findings.filter((finding) => finding.severity !== "info");
    if (actionable.length) {
      throw new Error(
        `upstream self-test needs a quiet baseline, got ${JSON.stringify(actionable, null, 2)}`,
      );
    }
  };
  await expectQuiet();

  const cases = [
    [
      "the upstream PR merges — time to drop the fork",
      {
        ...quiet(),
        githubJson: async (route) => {
          if (/\/issues\/\d+$/.test(route)) {
            return {
              state: "closed",
              pull_request: { merged_at: "2026-09-01T00:00:00Z" },
            };
          }
          return quiet().githubJson(route);
        },
      },
      baseline,
      "MERGED",
    ],
    [
      "the upstream PR is closed without merging",
      {
        ...quiet(),
        githubJson: async (route) => {
          if (/\/issues\/\d+$/.test(route)) {
            return { state: "closed", pull_request: { merged_at: null } };
          }
          return quiet().githubJson(route);
        },
      },
      baseline,
      "CLOSED without merging",
    ],
    [
      // The defect the coordinator caught in review: `/pulls/{n}` 404s on an
      // issue number, so registering an issue used to crash the run and read
      // as an outage. It must now be a named finding instead.
      "the registered exit reference is an issue, not a pull request",
      {
        ...quiet(),
        githubJson: async (route) => {
          if (/\/issues\/\d+$/.test(route)) {
            // No `pull_request` key: this is what a plain issue looks like.
            return { state: "closed", state_reason: "completed" };
          }
          if (/\/pulls\/\d+$/.test(route)) {
            throw new Error("GET pulls -> 404 Not Found");
          }
          return quiet().githubJson(route);
        },
      },
      baseline,
      "is an issue, not a pull request",
    ],
    [
      "the fork falls behind its upstream base",
      {
        ...quiet(),
        githubJson: async (route) => {
          if (route.includes("/compare/")) {
            return { status: "diverged", ahead_by: 1, behind_by: 11 };
          }
          return quiet().githubJson(route);
        },
      },
      baseline,
      "commits behind",
    ],
    [
      "the branch we build and the branch upstream reviews diverge",
      {
        ...quiet(),
        githubJson: async (route) => {
          if (route.includes("/branches/")) {
            return {
              commit: {
                sha: route.includes("upstream-drop") ? "c".repeat(40) : "b".repeat(40),
              },
            };
          }
          return quiet().githubJson(route);
        },
      },
      baseline,
      "have diverged",
    ],
    [
      "a .gitmodules branch no longer exists on its remote (the z3 failure mode)",
      { ...quiet(), remoteHasBranch: () => false },
      baseline,
      "does not exist on",
    ],
    [
      "crates.io publishes the release the patch was waiting for",
      { ...quiet(), cratesIo: async () => ({ crate: { max_stable_version: "0.6.0" } }) },
      baseline,
      "crates.io now publishes bip32 0.6.0",
    ],
    [
      "librustzcash moves off the secp256k1 version the patch is held to",
      quiet(),
      {
        ...baseline,
        sources: {
          ...baseline.sources,
          [LIBRUSTZCASH_MANIFEST]: baseline.sources[
            LIBRUSTZCASH_MANIFEST
          ].replace(
            'secp256k1 = { version = "0.29"',
            'secp256k1 = { version = "0.31"',
          ),
        },
      },
      "moved secp256k1 to 0.31",
    ],
    [
      "the register goes unverified for too long",
      { ...quiet(), today: new Date("2027-01-01T00:00:00Z") },
      baseline,
      "last verified",
    ],
  ];

  for (const [name, deps, snapshot, expected] of cases) {
    const findings = await upstreamFindings(snapshot, deps);
    if (!findings.some((finding) => finding.headline.includes(expected))) {
      throw new Error(
        `mutation escaped policy: ${name}\n  expected a finding containing: ${expected}\n  got: ${JSON.stringify(findings, null, 2)}`,
      );
    }
  }
  process.stdout.write(
    `self-test: killed ${cases.length} upstream dependency-register mutants.\n`,
  );
  return cases.length;
}

async function runUpstream() {
  const findings = await upstreamFindings(liveSnapshot());
  const actionable = findings.filter((finding) => finding.severity !== "info");
  for (const finding of findings) {
    const stream = finding.severity === "info" ? process.stdout : process.stderr;
    stream.write(`[${finding.severity}] ${finding.headline}\n    ${finding.detail}\n`);
  }
  if (actionable.length) {
    process.stderr.write(
      `\n${actionable.length} dependency-register finding(s) need an owner. See ${REGISTER_PATH}.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `Upstream check passed: every tracked fork is unmerged, within its drift limit, ` +
      `and every .gitmodules branch exists on its remote.\n`,
  );
}

async function runCli(args) {
  if (args.length === 1 && args[0] === "--self-test") {
    const offline = runSelfTest();
    const upstream = await runUpstreamSelfTest();
    process.stdout.write(
      `self-test passed: ${offline + upstream} mutants killed across both halves.\n`,
    );
    return;
  }
  if (args.length === 1 && args[0] === "--upstream") {
    await runUpstream();
    return;
  }
  if (args.length === 0) {
    const failures = offlineFailures(liveSnapshot());
    if (failures.length) {
      for (const failure of failures) process.stderr.write(`drift: ${failure}\n`);
      process.exit(1);
    }
    const evidenceCount = HOLDS.reduce(
      (total, hold) => total + (hold.evidence?.length ?? 0),
      0,
    );
    process.stdout.write(
      `${REGISTER_PATH} agrees with .gitmodules, ${PATCHABLE_MANIFESTS.length} patch site(s), ` +
        `${HOLDS.length} version holds and ${evidenceCount} measured consequences, ` +
        `re-read from ${HOLD_SOURCE_PATHS.length} file(s):\n` +
        HOLD_SOURCE_PATHS.map((sourcePath) => `  ${sourcePath}\n`).join(""),
    );
    return;
  }
  process.stderr.write(
    "usage: scripts/check-dependency-register.mjs [--self-test|--upstream]\n",
  );
  process.exit(2);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  // Exit 1 means "findings" and exit 2 means "this script or the network broke".
  // Node exits 1 on an uncaught throw, which would make an api.github.com
  // outage read as a merged upstream PR — the two must not share a code, since
  // dependency-register.yml opens an issue on 1 and goes red on 2.
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check-dependency-register failed: ${error?.stack ?? error}\n`);
    process.exit(2);
  }
}
