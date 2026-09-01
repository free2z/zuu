import assert from "node:assert/strict";
import test from "node:test";

import {
  BYTES_PER_GB,
  DEFAULT_THRESHOLD_BYTES,
  PROTECTED_SUBSTRINGS,
  familyOf,
  formatGB,
  isProtectedFamily,
  isPackagingFamily,
  summarizeFamilies,
  planEviction,
} from "./check-actions-cache-footprint.mjs";

function entry(id, key, sizeBytes, lastAccessedAt) {
  return { id, key, sizeBytes, lastAccessedAt, ref: "refs/heads/main" };
}

// ---------------------------------------------------------------------------
// familyOf: grouping by stripped content hash
// ---------------------------------------------------------------------------

test("familyOf strips a Swatinem/rust-cache two-hash suffix", () => {
  assert.equal(
    familyOf("v0-rust-zuuli-clippy-rust_clippy-Linux-x64-11111111-22222222"),
    "v0-rust-zuuli-clippy-rust_clippy-Linux-x64",
  );
});

test("familyOf strips a single sha256 suffix (setup-java, actions/cache)", () => {
  assert.equal(
    familyOf(
      "setup-java-Linux-x64-gradle-" + "a".repeat(64),
    ),
    "setup-java-Linux-x64-gradle",
  );
});

test("familyOf groups two differently-hashed entries into the same family", () => {
  const a = familyOf("setup-java-Linux-x64-gradle-" + "a".repeat(64));
  const b = familyOf("setup-java-Linux-x64-gradle-" + "b".repeat(64));
  assert.equal(a, b);
});

test("familyOf does not conflate gradle and gradle-wrapper", () => {
  const gradle = familyOf("setup-java-Linux-x64-gradle-" + "a".repeat(64));
  const wrapper = familyOf(
    "setup-java-Linux-x64-gradle-wrapper-" + "a".repeat(64),
  );
  assert.notEqual(gradle, wrapper);
});

test("familyOf leaves dotted version tokens alone", () => {
  assert.equal(
    familyOf("v0-rust-zuuli-release-macos-universal-v2-rust-1.97.1-Darwin-arm64-aaaaaaaa-bbbbbbbb"),
    "v0-rust-zuuli-release-macos-universal-v2-rust-1.97.1-Darwin-arm64",
  );
});

test("familyOf leaves out-of-hex-range platform tokens alone", () => {
  // "aarch64" contains 'r' which is not a hex digit, so it must survive.
  assert.equal(
    familyOf("v0-rust-zuuli-plugin-android-aarch64-Linux-x64-aaaaaaaa-bbbbbbbb"),
    "v0-rust-zuuli-plugin-android-aarch64-Linux-x64",
  );
});

// ---------------------------------------------------------------------------
// formatGB / isProtectedFamily / isPackagingFamily / summarizeFamilies
// ---------------------------------------------------------------------------

test("formatGB renders decimal GB to 2 places", () => {
  assert.equal(formatGB(1_660_000_000), "1.66 GB");
  assert.equal(formatGB(BYTES_PER_GB), "1.00 GB");
});

test("isProtectedFamily matches on any of the required-gate substrings", () => {
  for (const substring of PROTECTED_SUBSTRINGS) {
    assert.equal(isProtectedFamily(`v0-rust-zuuli-x-${substring}-Linux-x64`), true);
  }
  assert.equal(isProtectedFamily("v0-rust-zuuli-release-android-universal"), false);
});

test("isPackagingFamily matches release-* families only", () => {
  assert.equal(isPackagingFamily("v0-rust-zuuli-release-android-universal"), true);
  assert.equal(isPackagingFamily("v0-rust-zuuli-clippy-rust_clippy-Linux-x64"), false);
  // "prerelease-foo" must not false-positive on a bare substring match.
  assert.equal(isPackagingFamily("v0-rust-zuuli-prerelease-foo"), false);
});

test("summarizeFamilies aggregates size and count per family, largest first", () => {
  const entries = [
    entry(1, "node-cache-Linux-x64-npm-" + "a".repeat(64), 1 * BYTES_PER_GB, "2026-01-01T00:00:00Z"),
    entry(2, "node-cache-Linux-x64-npm-" + "b".repeat(64), 1 * BYTES_PER_GB, "2026-01-02T00:00:00Z"),
    entry(3, "v0-rust-zuuli-clippy-rust_clippy-Linux-x64-aaaaaaaa-bbbbbbbb", 3 * BYTES_PER_GB, "2026-01-03T00:00:00Z"),
  ];
  const summary = summarizeFamilies(entries);
  assert.deepEqual(
    summary.map((row) => [row.family, row.totalBytes, row.count]),
    [
      ["v0-rust-zuuli-clippy-rust_clippy-Linux-x64", 3 * BYTES_PER_GB, 1],
      ["node-cache-Linux-x64-npm", 2 * BYTES_PER_GB, 2],
    ],
  );
});

// ---------------------------------------------------------------------------
// planEviction: threshold maths
// ---------------------------------------------------------------------------

test("a total under the threshold evicts nothing", () => {
  const entries = [entry(1, "a-aaaaaa", 5 * BYTES_PER_GB, "2026-01-01T00:00:00Z")];
  const plan = planEviction(entries, { thresholdBytes: 8 * BYTES_PER_GB });
  assert.equal(plan.over, false);
  assert.deepEqual(plan.toDelete, []);
});

test("a total exactly at the threshold is not 'over' and evicts nothing", () => {
  const entries = [
    entry(1, "a-aaaaaa", 4 * BYTES_PER_GB, "2026-01-01T00:00:00Z"),
    entry(2, "b-bbbbbb", 4 * BYTES_PER_GB, "2026-01-02T00:00:00Z"),
  ];
  const plan = planEviction(entries, { thresholdBytes: 8 * BYTES_PER_GB });
  assert.equal(plan.over, false);
  assert.deepEqual(plan.toDelete, []);
});

test("evicts only as many entries as needed to reach the threshold", () => {
  const entries = [
    entry(1, "a-aaaaaa", 5 * BYTES_PER_GB, "2026-01-01T00:00:00Z"),
    entry(2, "b-bbbbbb", 5 * BYTES_PER_GB, "2026-01-02T00:00:00Z"),
  ];
  const plan = planEviction(entries, { thresholdBytes: 8 * BYTES_PER_GB });
  assert.equal(plan.toDelete.length, 1);
  assert.equal(plan.toDelete[0].id, 1); // the older of the two
  assert.equal(plan.remainingBytes, 5 * BYTES_PER_GB);
  assert.equal(plan.stillOver, false);
});

test("uses DEFAULT_THRESHOLD_BYTES of 8 GB when no threshold is given", () => {
  assert.equal(DEFAULT_THRESHOLD_BYTES, 8 * BYTES_PER_GB);
  const entries = [entry(1, "a-aaaaaa", 9 * BYTES_PER_GB, "2026-01-01T00:00:00Z")];
  const plan = planEviction(entries);
  assert.equal(plan.thresholdBytes, DEFAULT_THRESHOLD_BYTES);
  assert.equal(plan.over, true);
});

// ---------------------------------------------------------------------------
// planEviction: LRU ordering
// ---------------------------------------------------------------------------

test("within one non-required family, oldest last_accessed_at is evicted first", () => {
  const entries = [
    entry(1, "node-cache-Linux-x64-npm-" + "a".repeat(64), 3 * BYTES_PER_GB, "2026-03-01T00:00:00Z"),
    entry(2, "node-cache-Linux-x64-npm-" + "b".repeat(64), 3 * BYTES_PER_GB, "2026-01-01T00:00:00Z"),
    entry(3, "node-cache-Linux-x64-npm-" + "c".repeat(64), 3 * BYTES_PER_GB, "2026-02-01T00:00:00Z"),
  ];
  const plan = planEviction(entries, { thresholdBytes: 4 * BYTES_PER_GB });
  assert.deepEqual(plan.toDelete.map((e) => e.id), [2, 3]);
  assert.deepEqual(plan.toKeep.map((e) => e.id), [1]);
});

test("across different non-required families, oldest overall is evicted first", () => {
  const entries = [
    entry(1, "node-cache-Linux-x64-npm-" + "a".repeat(64), 2 * BYTES_PER_GB, "2026-06-01T00:00:00Z"),
    entry(2, "node-cache-macOS-arm64-npm-" + "b".repeat(64), 2 * BYTES_PER_GB, "2026-01-01T00:00:00Z"),
    entry(3, "setup-java-Linux-x64-gradle-" + "c".repeat(64), 2 * BYTES_PER_GB, "2026-03-01T00:00:00Z"),
  ];
  const plan = planEviction(entries, { thresholdBytes: 4 * BYTES_PER_GB });
  assert.deepEqual(plan.toDelete.map((e) => e.id), [2]);
});

// ---------------------------------------------------------------------------
// planEviction: protected-family exclusion
// ---------------------------------------------------------------------------

test("the sole entry of a protected family is never evicted, even when it is the oldest thing in the repo", () => {
  const entries = [
    entry(1, "v0-rust-zuuli-clippy-rust_clippy-Linux-x64-11111111-11111111", 6 * BYTES_PER_GB, "2020-01-01T00:00:00Z"),
    entry(2, "v0-rust-zuuli-app-rust_app-Linux-x64-22222222-22222222", 6 * BYTES_PER_GB, "2026-01-01T00:00:00Z"),
  ];
  const plan = planEviction(entries, { thresholdBytes: 8 * BYTES_PER_GB });
  assert.deepEqual(plan.toDelete, []);
  assert.equal(plan.over, true);
  assert.equal(plan.stillOver, true);
  assert.deepEqual([...plan.protectedIds].sort(), [1, 2]);
});

test("all four protected substrings are individually honored", () => {
  const entries = PROTECTED_SUBSTRINGS.map((substring, index) =>
    entry(
      index + 1,
      `v0-rust-zuuli-x-${substring}-Linux-x64-${String(index).repeat(8)}-${String(index).repeat(8)}`,
      3 * BYTES_PER_GB,
      "2020-01-01T00:00:00Z",
    ),
  );
  const plan = planEviction(entries, { thresholdBytes: 1 * BYTES_PER_GB });
  assert.deepEqual(plan.toDelete, []);
  assert.equal(plan.protectedIds.size, 4);
});

test("release-* packaging is evicted before touching an older duplicate inside a required family", () => {
  const entries = [
    entry(1, "v0-rust-zuuli-clippy-rust_clippy-Linux-x64-11111111-11111111", 3 * BYTES_PER_GB, "2020-01-01T00:00:00Z"),
    entry(2, "v0-rust-zuuli-clippy-rust_clippy-Linux-x64-22222222-22222222", 3 * BYTES_PER_GB, "2026-01-01T00:00:00Z"),
    entry(3, "v0-rust-zuuli-release-android-universal-v2-33333333-33333333", 3 * BYTES_PER_GB, "2025-06-01T00:00:00Z"),
  ];
  const plan = planEviction(entries, { thresholdBytes: 6 * BYTES_PER_GB });
  assert.deepEqual(plan.toDelete.map((e) => e.id), [3]);
  assert.equal(plan.stillOver, false);
});

test("an older duplicate inside a required family is evicted only as a last resort, never the newest", () => {
  const entries = [
    entry(1, "v0-rust-zuuli-clippy-rust_clippy-Linux-x64-11111111-11111111", 5 * BYTES_PER_GB, "2020-01-01T00:00:00Z"),
    entry(2, "v0-rust-zuuli-clippy-rust_clippy-Linux-x64-22222222-22222222", 5 * BYTES_PER_GB, "2026-01-01T00:00:00Z"),
  ];
  const plan = planEviction(entries, { thresholdBytes: 4 * BYTES_PER_GB });
  assert.deepEqual(plan.toDelete.map((e) => e.id), [1]);
  assert.deepEqual(plan.toKeep.map((e) => e.id), [2]);
  // 5 GB remains, still over a 4 GB threshold, but the newest is never touched.
  assert.equal(plan.stillOver, true);
});

test("end to end: packaging, then other non-required, before any required family is touched", () => {
  const entries = [
    entry(1, "v0-rust-zuuli-clippy-rust_clippy-Linux-x64-aaaaaaaa-aaaaaaaa", 2 * BYTES_PER_GB, "2026-08-01T00:00:00Z"),
    entry(2, "v0-rust-zuuli-app-rust_app-Linux-x64-bbbbbbbb-bbbbbbbb", 2 * BYTES_PER_GB, "2026-08-01T00:00:00Z"),
    entry(3, "v0-rust-zuuli-native-clippy-macos-rust_native_clippy-Darwin-arm64-cccccccc-cccccccc", 2 * BYTES_PER_GB, "2026-08-01T00:00:00Z"),
    entry(4, "v0-rust-zuuli-native-tests-macos-rust_native_tests-Darwin-arm64-dddddddd-dddddddd", 2 * BYTES_PER_GB, "2026-08-01T00:00:00Z"),
    entry(5, "v0-rust-zuuli-release-android-universal-v2-eeeeeeee-eeeeeeee", 2 * BYTES_PER_GB, "2026-01-01T00:00:00Z"),
    entry(6, "v0-rust-zuuli-release-macos-universal-v2-ffffffff-ffffffff", 2 * BYTES_PER_GB, "2026-02-01T00:00:00Z"),
    entry(7, "node-cache-Linux-x64-npm-" + "1".repeat(64), 2 * BYTES_PER_GB, "2026-03-01T00:00:00Z"),
  ];
  const plan = planEviction(entries, { thresholdBytes: 8 * BYTES_PER_GB });
  assert.deepEqual(plan.toDelete.map((e) => e.id), [5, 6, 7]);
  assert.equal(plan.stillOver, false);
  for (const requiredId of [1, 2, 3, 4]) {
    assert.ok(plan.toKeep.some((e) => e.id === requiredId), `id ${requiredId} must survive`);
  }
});

test("an empty cache list is under threshold and evicts nothing", () => {
  const plan = planEviction([], { thresholdBytes: DEFAULT_THRESHOLD_BYTES });
  assert.equal(plan.totalBytes, 0);
  assert.equal(plan.over, false);
  assert.deepEqual(plan.toDelete, []);
});
