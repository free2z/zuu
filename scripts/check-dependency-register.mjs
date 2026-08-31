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
//   manifests carrying `[patch.crates-io]`, `z/zcash/librustzcash/Cargo.toml`
//   and the register itself. Deterministic, so it is safe on a pull request and
//   runs on one.
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

/// Version requirements that are UPSTREAM librustzcash's, not ours, read back
/// out of `z/zcash/librustzcash/Cargo.toml`'s `[workspace.dependencies]`.
///
/// This is the rule that keeps section 3 of the register honest. Each entry is
/// a claim the register makes about who forces a hold; if upstream bumps
/// `rusqlite` to 0.38, the register's row becomes false and this goes red
/// instead of the page quietly lying.
const UPSTREAM_HOLDS = new Map([
  ["rusqlite", "0.37"],
  ["secrecy", "0.8"],
  ["secp256k1", "0.29"],
  ["rand", "0.8"],
  ["sha2", "0.10"],
  ["bip32", "=0.6.0-pre.1"],
]);

/// Holds the register attributes to *us*. The claim being checked is the
/// negative one — that librustzcash does not declare these at all — because
/// "our own choice" stops being true the moment upstream takes a position.
const OUR_OWN_HOLDS = new Set(["hkdf"]);

/// Strings section 3 of the register must contain, so a hold cannot be dropped
/// from the page while the version is still pinned in the tree.
const HOLD_TOKENS = [
  "`rusqlite` | 0.37",
  "`secrecy` | 0.8",
  "`secp256k1` | 0.29",
  "`rand` | 0.8",
  "`sha2` | 0.10",
  "`hkdf` | 0.12",
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

/// The version requirement each crate carries in one `[workspace.dependencies]`
/// table. Continuation lines are joined on brace balance so a multi-line entry
/// is read whole rather than half.
export function parseWorkspaceDependencies(text) {
  const lines = text.split("\n");
  const start = lines.findIndex(
    (line) => line.trim() === "[workspace.dependencies]",
  );
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

/// `snapshot` is `{ gitmodules, librustzcash, register, manifests }`, where
/// `manifests` maps every tracked `Cargo.toml` path to its contents. Taking a
/// snapshot rather than reading files here is what lets the self-test mutate
/// one input at a time and watch this fail.
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

  // Section 3: every "upstream forces it" claim, re-read from upstream.
  const workspace = parseWorkspaceDependencies(snapshot.librustzcash);
  if (workspace.size === 0) {
    failures.push(
      `${LIBRUSTZCASH_MANIFEST}: no [workspace.dependencies] found — ` +
        "is the submodule checked out? (git submodule update --init z/zcash/librustzcash)",
    );
  } else {
    for (const [crate, expected] of UPSTREAM_HOLDS) {
      const actual = workspace.get(crate);
      if (actual === undefined) {
        failures.push(
          `${crate}: register says upstream librustzcash forces ${expected}, ` +
            "but it declares no such workspace dependency any more",
        );
      } else if (actual !== expected) {
        failures.push(
          `${crate}: register says upstream librustzcash forces ${expected}, ` +
            `it now declares ${actual} — the hold's stated justification is stale`,
        );
      }
    }
    for (const crate of OUR_OWN_HOLDS) {
      if (workspace.has(crate)) {
        failures.push(
          `${crate}: register calls this hold our own choice, but upstream ` +
            `librustzcash now declares ${workspace.get(crate)} — re-attribute it`,
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
    ...HOLD_TOKENS,
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
      const workspace = parseWorkspaceDependencies(snapshot.librustzcash);
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
  return {
    gitmodules: read(GITMODULES_PATH),
    librustzcash: read(LIBRUSTZCASH_MANIFEST),
    register: read(REGISTER_PATH),
    manifests,
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
  const withLibrustzcash = (text) => ({ ...baseline, librustzcash: text });
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
      withLibrustzcash(
        baseline.librustzcash.replace(
          'rusqlite = { version = "0.37"',
          'rusqlite = { version = "0.38"',
        ),
      ),
      "it now declares 0.38",
    ],
    [
      "upstream librustzcash drops a hold the register says it forces",
      withLibrustzcash(
        baseline.librustzcash.replace(/^secrecy = "0\.8"$/m, "# secrecy gone"),
      ),
      "declares no such workspace dependency any more",
    ],
    [
      "upstream takes a position on a hold the register calls our own",
      withLibrustzcash(
        baseline.librustzcash.replace(
          'sha2 = { version = "0.10", default-features = false }',
          'sha2 = { version = "0.10", default-features = false }\nhkdf = { version = "0.13", default-features = false }',
        ),
      ),
      "register calls this hold our own choice",
    ],
    [
      "the librustzcash submodule is not checked out",
      withLibrustzcash(""),
      "is the submodule checked out?",
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
      withRegister(baseline.register.replace("`hkdf` | 0.12", "")),
      "does not mention ``hkdf` | 0.12`",
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
        librustzcash: baseline.librustzcash.replace(
          'secp256k1 = { version = "0.29"',
          'secp256k1 = { version = "0.31"',
        ),
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
    process.stdout.write(
      `${REGISTER_PATH} agrees with .gitmodules, ${PATCHABLE_MANIFESTS.length} patch site(s), ` +
        `and ${UPSTREAM_HOLDS.size} upstream-forced version holds.\n`,
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
