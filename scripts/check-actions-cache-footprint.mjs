#!/usr/bin/env node
//
// Guard the repository's GitHub Actions cache footprint below the platform's
// 10 GB-per-repository eviction ceiling.
//
// ## The failure this exists to prevent
//
// GitHub Actions caches a repository can hold are capped at 10 GB total. Once
// a repository crosses that ceiling, GitHub silently evicts least-recently-used
// entries to get back under it — there is no error, no notification, no log
// line. The only symptom is the *next* run that needed the evicted entry
// printing `No cache found.` and falling back to a cold build. On this repo
// that cold path is a 29-minute librustzcash rebuild inside the REQUIRED
// `Rust / lints` gate. Nobody noticed the footprint crossing 10 GB because
// nothing was watching it; `.github/workflows/cache-cleanup.yml` only ever
// deleted caches that belonged to closed PRs, which does nothing about the
// steady-state families (release packaging smoke, duplicate setup-java /
// npm caches) that accumulate on `main` itself.
//
// ## What this script does
//
//   1. List every cache entry in the repository (paginated).
//   2. Group entries into "families" by stripping the trailing content-hash
//      segments from each cache key, and report total size / count overall
//      and per family.
//   3. If the total exceeds a threshold (default 8 GB, leaving headroom below
//      the 10 GB ceiling), select least-recently-used entries to delete until
//      back under the threshold — while protecting the caches that back the
//      required `gate` from ever being the thing evicted.
//
// ## The protection rule
//
// A cache key whose family contains `rust_clippy`, `rust_app`,
// `rust_native_clippy`, or `rust_native_tests` backs a REQUIRED gate job. The
// single most-recently-accessed entry in each such family is never a deletion
// candidate, full stop — even if every other entry in the repository has
// already been deleted and the total is still over threshold. Deletion always
// prefers, in order: (1) `release-*` packaging-smoke families (not required),
// (2) other non-required families and their stale duplicates, (3) only as a
// last resort, older entries within a required family (its newest entry is
// still always kept).
//
// ## Why the API call failing is a hard failure
//
// A guard that silently no-ops when it cannot see the data it is supposed to
// act on is worse than no guard: it *looks* like protection while providing
// none, which is the exact shape of the failure that let the footprint cross
// 10 GB unnoticed in the first place (see #636 for the same lesson learned
// elsewhere). `fetchCaches` below does not catch API errors; the process is
// left to exit non-zero.
//
// Usage:
//   node scripts/check-actions-cache-footprint.mjs             report + evict live
//   node scripts/check-actions-cache-footprint.mjs --dry-run   report what WOULD be evicted
//   node scripts/check-actions-cache-footprint.mjs --self-test negative controls first

import { execFileSync } from "node:child_process";

/// Decimal GB, matching how GitHub documents the 10 GB ceiling and how this
/// repo's operators measured the footprint that motivated this script (a
/// `size_in_bytes` sum of 10,700,000,000-ish reads as "10.70 GB").
export const BYTES_PER_GB = 1_000_000_000;

/// Default ceiling this guard enforces, chosen to leave 2 GB of headroom
/// below GitHub's 10 GB eviction ceiling.
export const DEFAULT_THRESHOLD_BYTES = 8 * BYTES_PER_GB;

/// A cache family containing any of these substrings backs a REQUIRED job in
/// the `gate` workflow. Evicting the newest entry in one of these families is
/// precisely the failure this script exists to prevent.
export const PROTECTED_SUBSTRINGS = [
  "rust_clippy",
  "rust_app",
  "rust_native_clippy",
  "rust_native_tests",
];

/// A trailing run of one or more hyphen-joined pure-hex segments, 6-64 hex
/// characters each. Cache-action keys append content/job hashes this shape
/// (Swatinem/rust-cache appends two 8-hex segments; actions/setup-java and
/// actions/cache append one 64-hex sha256). Stripping them groups repeat runs
/// of the same job — including ones with different lockfile hashes — into one
/// family, which is what lets this script see "3 duplicate node-cache
/// entries" instead of 3 unrelated-looking keys.
///
/// Deliberately hex-only: version/platform tokens in real keys (`24.04`,
/// `4.1`, `x64`, `aarch64`, `1.97.1`) all fail this test, either because they
/// contain a `.` or an out-of-range letter, so they are never stripped.
const TRAILING_HASH_SEGMENTS = /(?:-[0-9a-f]{6,64})+$/i;

/// Strip the trailing content-hash segments from a cache key to get its
/// family. Two entries in the same family are the same job's cache at two
/// different points in time (or two different lockfile hashes) — exactly the
/// duplication this guard is meant to prune.
export function familyOf(key) {
  return key.replace(TRAILING_HASH_SEGMENTS, "");
}

export function formatGB(bytes) {
  return `${(bytes / BYTES_PER_GB).toFixed(2)} GB`;
}

export function isProtectedFamily(family, protectedSubstrings = PROTECTED_SUBSTRINGS) {
  return protectedSubstrings.some((substring) => family.includes(substring));
}

/// `release-*` packaging-smoke families: not required by the gate, and named
/// first in the eviction preference order.
export function isPackagingFamily(family) {
  return /(^|-)release-/.test(family);
}

/// Per-family totals, largest first, for the human-readable summary.
export function summarizeFamilies(entries) {
  const byFamily = new Map();
  for (const entry of entries) {
    const family = familyOf(entry.key);
    if (!byFamily.has(family)) byFamily.set(family, { family, totalBytes: 0, count: 0 });
    const row = byFamily.get(family);
    row.totalBytes += entry.sizeBytes;
    row.count += 1;
  }
  return [...byFamily.values()].sort((a, b) => b.totalBytes - a.totalBytes);
}

/// Decide which entries to delete to bring the total back under
/// `thresholdBytes`, honoring the protection rule.
///
/// Every input is injectable so the self-test and the `node --test` suite
/// judge fixtures against fixture configuration, never against this script's
/// idea of the real repository.
export function planEviction(entries, options = {}) {
  const {
    thresholdBytes = DEFAULT_THRESHOLD_BYTES,
    protectedSubstrings = PROTECTED_SUBSTRINGS,
  } = options;

  const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);

  // The newest entry of each protected family is never a candidate. "Newest"
  // is decided per family, not globally, so a protected family with only one
  // entry still has that one entry protected.
  const newestByFamily = new Map();
  for (const entry of entries) {
    const family = familyOf(entry.key);
    const current = newestByFamily.get(family);
    if (!current || entry.lastAccessedAt > current.lastAccessedAt) {
      newestByFamily.set(family, entry);
    }
  }
  const protectedIds = new Set();
  for (const [family, newest] of newestByFamily) {
    if (isProtectedFamily(family, protectedSubstrings)) protectedIds.add(newest.id);
  }

  // Tier 0: release-* packaging smoke. Tier 1: other non-required families
  // (includes stale duplicates of e.g. node-cache/setup-java). Tier 2: older
  // entries within a required family, once its newest entry is excluded.
  // Within a tier, oldest last_accessed_at goes first — the definition of
  // least-recently-used.
  function tierOf(entry) {
    const family = familyOf(entry.key);
    if (isPackagingFamily(family)) return 0;
    if (!isProtectedFamily(family, protectedSubstrings)) return 1;
    return 2;
  }

  const eligible = entries
    .filter((entry) => !protectedIds.has(entry.id))
    .sort((a, b) => {
      const tierDelta = tierOf(a) - tierOf(b);
      if (tierDelta !== 0) return tierDelta;
      if (a.lastAccessedAt < b.lastAccessedAt) return -1;
      if (a.lastAccessedAt > b.lastAccessedAt) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const toDelete = [];
  let runningTotal = totalBytes;
  for (const entry of eligible) {
    if (runningTotal <= thresholdBytes) break;
    toDelete.push(entry);
    runningTotal -= entry.sizeBytes;
  }

  const deletedIds = new Set(toDelete.map((entry) => entry.id));
  const toKeep = entries.filter((entry) => !deletedIds.has(entry.id));

  return {
    totalBytes,
    thresholdBytes,
    over: totalBytes > thresholdBytes,
    toDelete,
    toKeep,
    remainingBytes: runningTotal,
    stillOver: runningTotal > thresholdBytes,
    protectedIds,
  };
}

// ---------------------------------------------------------------------------
// Live data: gh api, paginated
// ---------------------------------------------------------------------------

/// Fetch every cache entry via `gh api`, using gh's built-in `{owner}/{repo}`
/// template resolution (from `GH_REPO` or the git remote) and pagination.
///
/// `--jq '.actions_caches[]'` streams one JSON object per line across every
/// page. This function does not catch `execFileSync` failures: an API error,
/// an auth failure, a rate limit — anything that makes `gh` exit non-zero —
/// propagates as an uncaught exception and the process exits non-zero. A
/// guard that swallows the one failure mode where it cannot see its own data
/// is worse than no guard (see the module note on #636).
export function fetchCaches({ execFile = execFileSync } = {}) {
  const output = execFile(
    "gh",
    [
      "api",
      "repos/{owner}/{repo}/actions/caches",
      "--paginate",
      "--jq",
      ".actions_caches[]",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const raw = JSON.parse(line);
      return {
        id: raw.id,
        key: raw.key,
        sizeBytes: raw.size_in_bytes,
        lastAccessedAt: raw.last_accessed_at,
        createdAt: raw.created_at,
        ref: raw.ref,
      };
    });
}

function deleteCache(id, { execFile = execFileSync } = {}) {
  execFile("gh", ["cache", "delete", String(id)], { encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function ageDays(lastAccessedAt) {
  const ms = Date.now() - new Date(lastAccessedAt).getTime();
  return (ms / (1000 * 60 * 60 * 24)).toFixed(1);
}

function printSummary(entries, thresholdBytes) {
  const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  console.log(
    `Actions cache footprint: ${formatGB(totalBytes)} across ${entries.length} ` +
      `entr${entries.length === 1 ? "y" : "ies"} ` +
      `(threshold ${formatGB(thresholdBytes)}, GitHub ceiling 10.00 GB).`,
  );
  console.log("Per-family breakdown:");
  for (const row of summarizeFamilies(entries)) {
    const flags = [
      isProtectedFamily(row.family) ? "protected" : null,
      isPackagingFamily(row.family) ? "packaging" : null,
    ].filter(Boolean);
    const suffix = flags.length ? ` [${flags.join(", ")}]` : "";
    console.log(
      `  ${formatGB(row.totalBytes).padStart(9)}  ${row.family} ` +
        `(${row.count} entr${row.count === 1 ? "y" : "ies"})${suffix}`,
    );
  }
}

function printPlan(plan, { verb }) {
  if (plan.toDelete.length === 0) {
    console.log(
      plan.over
        ? "Over threshold, but no eligible (non-protected) entry remains to evict."
        : "Under threshold; nothing to evict.",
    );
    return;
  }
  console.log(
    `${verb} ${plan.toDelete.length} entr${plan.toDelete.length === 1 ? "y" : "ies"} ` +
      `to bring the total from ${formatGB(plan.totalBytes)} to ` +
      `${formatGB(plan.remainingBytes)} (threshold ${formatGB(plan.thresholdBytes)}):`,
  );
  for (const entry of plan.toDelete) {
    console.log(
      `  - ${entry.key} — ${formatGB(entry.sizeBytes)}, ` +
        `last accessed ${entry.lastAccessedAt} (${ageDays(entry.lastAccessedAt)}d ago)`,
    );
  }
  if (plan.stillOver) {
    console.warn(
      `Warning: ${formatGB(plan.remainingBytes)} remains over the ` +
        `${formatGB(plan.thresholdBytes)} threshold after evicting every eligible entry; ` +
        "the rest is protected required-gate cache and will not be touched.",
    );
  }
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function entry(id, key, sizeBytes, lastAccessedAt) {
  return { id, key, sizeBytes, lastAccessedAt, ref: "refs/heads/main" };
}

let cases = 0;

function assertEqual(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`self-test FAILED: ${label}: expected ${e}, got ${a}`);
  }
  cases += 1;
  console.log(`self-test: ${label} passes.`);
}

function assertIds(label, actualEntries, expectedIds) {
  assertEqual(
    label,
    actualEntries.map((e) => e.id),
    expectedIds,
  );
}

function selfTest() {
  // familyOf: real key shapes from this repo, verbatim.
  assertEqual(
    "familyOf strips a Swatinem/rust-cache two-hash suffix",
    familyOf(
      "v0-rust-zuuli-native-clippy-macos-rust_native_clippy-Darwin-arm64-1bdbddfc-c62c39e8",
    ),
    "v0-rust-zuuli-native-clippy-macos-rust_native_clippy-Darwin-arm64",
  );
  assertEqual(
    "familyOf strips a setup-java sha256 suffix",
    familyOf(
      "setup-java-Linux-x64-gradle-daffde3f80e77f81622bcde094121779b87f7adf3553fe394f60e73b889bf7e4",
    ),
    "setup-java-Linux-x64-gradle",
  );
  assertEqual(
    "familyOf groups setup-java gradle-wrapper separately from gradle",
    familyOf(
      "setup-java-Linux-x64-gradle-wrapper-78646bc7840291a46a57a204e13bd0656326a5975001cc23ffa2e27ba6658af7",
    ),
    "setup-java-Linux-x64-gradle-wrapper",
  );
  assertEqual(
    "familyOf leaves version/platform tokens alone (dots and out-of-range letters)",
    familyOf(
      "v0-rust-zuuli-release-macos-universal-v2-rust-1.97.1-xcode-26.6-macos-arm64-x86_64-Darwin-arm64-f9b08cb2-9e51e2a5",
    ),
    "v0-rust-zuuli-release-macos-universal-v2-rust-1.97.1-xcode-26.6-macos-arm64-x86_64-Darwin-arm64",
  );

  // Threshold maths.
  {
    const entries = [entry(1, "a-aaaaaa", 5 * BYTES_PER_GB, "2026-01-01T00:00:00Z")];
    const plan = planEviction(entries, { thresholdBytes: 8 * BYTES_PER_GB });
    assertEqual("a 5 GB total is not over an 8 GB threshold", plan.over, false);
    assertIds("nothing is evicted when under threshold", plan.toDelete, []);
  }
  {
    const entries = [
      entry(1, "a-aaaaaa", 4 * BYTES_PER_GB, "2026-01-01T00:00:00Z"),
      entry(2, "b-bbbbbb", 4 * BYTES_PER_GB, "2026-01-02T00:00:00Z"),
    ];
    const plan = planEviction(entries, { thresholdBytes: 8 * BYTES_PER_GB });
    assertEqual("a total exactly at threshold is not 'over'", plan.over, false);
  }
  {
    const entries = [
      entry(1, "a-aaaaaa", 5 * BYTES_PER_GB, "2026-01-01T00:00:00Z"),
      entry(2, "b-bbbbbb", 5 * BYTES_PER_GB, "2026-01-02T00:00:00Z"),
    ];
    const plan = planEviction(entries, { thresholdBytes: 8 * BYTES_PER_GB });
    assertEqual("a 10 GB total is over an 8 GB threshold", plan.over, true);
    assertEqual("evicting the older 5 GB entry is enough to clear an 8 GB threshold", plan.remainingBytes, 5 * BYTES_PER_GB);
  }

  // LRU ordering: among candidates in the same tier, oldest goes first.
  {
    const entries = [
      entry(1, "node-cache-Linux-x64-npm-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 3 * BYTES_PER_GB, "2026-03-01T00:00:00Z"),
      entry(2, "node-cache-Linux-x64-npm-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 3 * BYTES_PER_GB, "2026-01-01T00:00:00Z"),
      entry(3, "node-cache-Linux-x64-npm-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", 3 * BYTES_PER_GB, "2026-02-01T00:00:00Z"),
    ];
    const plan = planEviction(entries, { thresholdBytes: 4 * BYTES_PER_GB });
    // 9 GB total, need to drop to <= 4 GB: evict oldest (id 2), then next
    // oldest (id 3); id 1 (newest) is kept.
    assertIds("LRU: oldest same-family duplicate is evicted first", plan.toDelete, [2, 3]);
  }

  // Protected-family exclusion.
  {
    const entries = [
      entry(1, "v0-rust-zuuli-clippy-rust_clippy-Linux-x64-11111111-11111111", 6 * BYTES_PER_GB, "2020-01-01T00:00:00Z"),
      entry(2, "v0-rust-zuuli-app-rust_app-Linux-x64-22222222-22222222", 6 * BYTES_PER_GB, "2026-01-01T00:00:00Z"),
    ];
    const plan = planEviction(entries, { thresholdBytes: 8 * BYTES_PER_GB });
    // Both families are required-gate families with exactly one entry each —
    // both are each family's "newest" and so both are protected, even though
    // the total is over threshold and entry 1 is by far the oldest thing in
    // the repository.
    assertIds("the sole entry of a protected family is never evicted, even when oldest", plan.toDelete, []);
    assertEqual("stillOver is reported when protection prevents clearing the threshold", plan.stillOver, true);
  }
  {
    const entries = [
      entry(1, "v0-rust-zuuli-clippy-rust_clippy-Linux-x64-11111111-11111111", 3 * BYTES_PER_GB, "2020-01-01T00:00:00Z"),
      entry(2, "v0-rust-zuuli-clippy-rust_clippy-Linux-x64-22222222-22222222", 3 * BYTES_PER_GB, "2026-01-01T00:00:00Z"),
      entry(3, "v0-rust-zuuli-release-android-universal-v2-33333333-33333333", 3 * BYTES_PER_GB, "2025-06-01T00:00:00Z"),
    ];
    const plan = planEviction(entries, { thresholdBytes: 6 * BYTES_PER_GB });
    // 9 GB total, threshold 6 GB. Packaging (id 3) goes first even though the
    // older required-family duplicate (id 1) is older still; only after
    // packaging is exhausted would the required family's non-newest entry be
    // touched, and here evicting just id 3 already clears the threshold, so
    // the required family's older duplicate (id 1) survives.
    assertIds("release-* packaging is preferred over an older duplicate in a required family", plan.toDelete, [3]);
    assertEqual("clearing packaging alone was enough here", plan.stillOver, false);
  }
  {
    const entries = [
      entry(1, "v0-rust-zuuli-clippy-rust_clippy-Linux-x64-11111111-11111111", 5 * BYTES_PER_GB, "2020-01-01T00:00:00Z"),
      entry(2, "v0-rust-zuuli-clippy-rust_clippy-Linux-x64-22222222-22222222", 5 * BYTES_PER_GB, "2026-01-01T00:00:00Z"),
    ];
    const plan = planEviction(entries, { thresholdBytes: 4 * BYTES_PER_GB });
    // Only one family, both entries required. The newest (id 2) must be kept;
    // the older duplicate (id 1) is the last-resort tier and is evicted
    // because nothing else is available.
    assertIds("an older duplicate within a required family is the last resort, not off-limits", plan.toDelete, [1]);
    assertEqual(
      "evicting the older duplicate is not enough on its own, but the newest is still never touched",
      plan.stillOver,
      true,
    );
  }

  // Tier ordering end to end, mirroring the shape of the real footprint.
  {
    const entries = [
      entry(1, "v0-rust-zuuli-clippy-rust_clippy-Linux-x64-aaaaaaaa-aaaaaaaa", 2 * BYTES_PER_GB, "2026-08-01T00:00:00Z"),
      entry(2, "v0-rust-zuuli-app-rust_app-Linux-x64-bbbbbbbb-bbbbbbbb", 2 * BYTES_PER_GB, "2026-08-01T00:00:00Z"),
      entry(3, "v0-rust-zuuli-native-clippy-macos-rust_native_clippy-Darwin-arm64-cccccccc-cccccccc", 2 * BYTES_PER_GB, "2026-08-01T00:00:00Z"),
      entry(4, "v0-rust-zuuli-native-tests-macos-rust_native_tests-Darwin-arm64-dddddddd-dddddddd", 2 * BYTES_PER_GB, "2026-08-01T00:00:00Z"),
      entry(5, "v0-rust-zuuli-release-android-universal-v2-eeeeeeee-eeeeeeee", 2 * BYTES_PER_GB, "2026-01-01T00:00:00Z"),
      entry(6, "v0-rust-zuuli-release-macos-universal-v2-ffffffff-ffffffff", 2 * BYTES_PER_GB, "2026-02-01T00:00:00Z"),
      entry(7, "node-cache-Linux-x64-npm-1111111111111111111111111111111111111111111111111111111111111111", 2 * BYTES_PER_GB, "2026-03-01T00:00:00Z"),
    ];
    const plan = planEviction(entries, { thresholdBytes: 8 * BYTES_PER_GB });
    // 14 GB total, need to shed 6 GB. Order: packaging oldest-first (5, 6),
    // then non-required non-packaging (7). Nothing required is ever touched.
    assertIds(
      "end-to-end preference: packaging before other non-required, required gate families untouched",
      plan.toDelete,
      [5, 6, 7],
    );
    assertEqual("all 4 required-gate entries survive", plan.stillOver, false);
  }

  console.log(`check-actions-cache-footprint self-test: ${cases} case(s) passed.`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
//
// Guarded behind the direct-execution check below: importing this module
// (as the `node --test` sibling file does, to reach the exported pure
// functions) must never itself talk to `gh`, let alone delete a live cache.
// Only running this file directly reaches the API.

function main() {
  const args = process.argv.slice(2);
  const mode = args.find((arg) => arg.startsWith("--")) ?? null;
  if (mode && mode !== "--self-test" && mode !== "--dry-run") {
    console.error(
      "usage: node scripts/check-actions-cache-footprint.mjs [--dry-run|--self-test]",
    );
    process.exit(2);
  }

  if (mode === "--self-test") {
    selfTest();
    process.exit(0);
  }

  const entries = fetchCaches();
  printSummary(entries, DEFAULT_THRESHOLD_BYTES);
  const plan = planEviction(entries, { thresholdBytes: DEFAULT_THRESHOLD_BYTES });

  if (mode === "--dry-run") {
    printPlan(plan, { verb: "Would delete" });
    process.exit(0);
  }

  printPlan(plan, { verb: "Deleting" });
  for (const victim of plan.toDelete) {
    deleteCache(victim.id);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
