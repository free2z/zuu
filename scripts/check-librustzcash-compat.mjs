#!/usr/bin/env node

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUBMODULE_PATH = "z/zcash/librustzcash";
// This is an independently reviewed identity decision. Never derive it from
// the index or working tree: doing so would make a stale pin self-approving.
const EXPECTED_LIBRUSTZCASH_SHA =
  "330e4c0aa9e25199acdb93a56bf70126d0d3f2b9";
const SEND_SOURCE =
  "wallet/plugins/tauri-plugin-zcash/src/wallet/send.rs";
const WALLET_SOURCE =
  "wallet/plugins/tauri-plugin-zcash/src/wallet/mod.rs";
const LOCKFILES = [
  "wallet/plugins/tauri-plugin-zcash/Cargo.lock",
  "wallet/zuuli/src-tauri/Cargo.lock",
  "wallet/zuuallet/src-tauri/Cargo.lock",
];
// These are the compatible crate identities reviewed with the gitlink above.
// They are deliberately literals rather than values read from one lockfile and
// compared with the others; all three locks drifting together must still fail.
const EXPECTED_PACKAGES = new Map([
  ["orchard", "0.15.3"],
  ["pczt", "0.9.3"],
  ["zcash_client_backend", "0.24.0"],
  ["zcash_client_sqlite", "0.22.0"],
  ["zcash_keys", "0.16.1"],
  ["zcash_pool_migration", "0.1.0"],
  ["zcash_primitives", "0.30.1"],
  ["zcash_proofs", "0.30.0"],
  ["zcash_protocol", "0.10.5"],
  ["zcash_transparent", "0.10.0"],
  ["zip321", "0.9.0"],
]);
// These independent literals make the guarded inventory fail closed. The
// digest is deliberately not derived into its expected value at runtime: a
// lock or package disappearing from the declarations above must make both the
// live verdict and the self-test red until a reviewer accepts a new scope.
const REVIEWED_LOCKFILE_COUNT = 3;
const REVIEWED_PACKAGE_COUNT = 11;
const REVIEWED_SCOPE_DIGEST =
  "4b4115dff3d451ca9f4576881fb80e3b7b1c33b465e69968048e18b9bf0325ab";

export function reviewedCompatibilityScope() {
  return {
    lockfiles: [...LOCKFILES],
    packages: new Map(EXPECTED_PACKAGES),
  };
}

export function compatibilityScopeIdentity(
  scope = reviewedCompatibilityScope(),
) {
  return JSON.stringify({
    lockfiles: scope.lockfiles,
    packages: [...scope.packages],
  });
}

function scopeErrors(scope) {
  const errors = [];
  if (scope.lockfiles.length !== REVIEWED_LOCKFILE_COUNT) {
    errors.push(
      `reviewed scope must contain exactly ${REVIEWED_LOCKFILE_COUNT} shipping locks, got ${scope.lockfiles.length}`,
    );
  }
  if (scope.packages.size !== REVIEWED_PACKAGE_COUNT) {
    errors.push(
      `reviewed scope must contain exactly ${REVIEWED_PACKAGE_COUNT} packages, got ${scope.packages.size}`,
    );
  }
  const digest = createHash("sha256")
    .update(compatibilityScopeIdentity(scope))
    .digest("hex");
  if (digest !== REVIEWED_SCOPE_DIGEST) {
    errors.push(
      `reviewed lock/package scope digest must remain ${REVIEWED_SCOPE_DIGEST}, got ${digest}`,
    );
  }
  return errors;
}

function stripRustComments(source) {
  let output = "";
  let state = "code";
  let blockDepth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (state === "line") {
      if (current === "\n") {
        output += current;
        state = "code";
      } else {
        output += " ";
      }
      continue;
    }
    if (state === "block") {
      if (current === "/" && next === "*") {
        blockDepth += 1;
        output += "  ";
        index += 1;
      } else if (current === "*" && next === "/") {
        blockDepth -= 1;
        output += "  ";
        index += 1;
        if (blockDepth === 0) state = "code";
      } else {
        output += current === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (state === "string" || state === "char") {
      output += current;
      if (current === "\\") {
        if (next !== undefined) {
          output += next;
          index += 1;
        }
      } else if (
        (state === "string" && current === '"') ||
        (state === "char" && current === "'")
      ) {
        state = "code";
      }
      continue;
    }

    if (current === "/" && next === "/") {
      state = "line";
      output += "  ";
      index += 1;
    } else if (current === "/" && next === "*") {
      state = "block";
      blockDepth = 1;
      output += "  ";
      index += 1;
    } else {
      output += current;
      if (current === '"') state = "string";
      if (current === "'") state = "char";
    }
  }
  return output;
}

function normalizedRust(source) {
  return stripRustComments(source).replace(/\s+/g, " ").trim();
}

function occurrences(source, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function packageVersions(lock, expectedPackages) {
  const versions = new Map();
  for (const block of lock.split(/^\[\[package\]\]$/m).slice(1)) {
    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    const version = block.match(/^version = "([^"]+)"$/m)?.[1];
    if (!name || !version || !expectedPackages.has(name)) continue;
    const found = versions.get(name) ?? [];
    found.push(version);
    versions.set(name, found);
  }
  return versions;
}

function validate(snapshot, scope = reviewedCompatibilityScope()) {
  const errors = scopeErrors(scope);
  if (snapshot.gitlink !== EXPECTED_LIBRUSTZCASH_SHA) {
    errors.push(
      `librustzcash gitlink must be reviewed ${EXPECTED_LIBRUSTZCASH_SHA}, got ${snapshot.gitlink}`,
    );
  }

  const send = normalizedRust(snapshot.files[SEND_SOURCE]);
  const lockHelper =
    "fn proposal_lock_request() -> Option<LockRequest> { None }";
  const versionHelper =
    "fn proposed_transaction_version() -> Option<TxVersion> { None }";
  if (
    occurrences(send, "fn proposal_lock_request()") !== 1 ||
    occurrences(send, lockHelper) !== 1
  ) {
    errors.push("proposal lock decision must remain one exact audited None helper");
  }
  if (
    occurrences(send, "fn proposed_transaction_version()") !== 1 ||
    occurrences(send, versionHelper) !== 1
  ) {
    errors.push(
      "transaction version decision must remain one exact audited None helper",
    );
  }
  const auditedTail =
    "&SpendPolicy::default(), proposal_lock_request(), proposed_transaction_version(),";
  if (
    occurrences(send, "propose_transfer::<") !== 2 ||
    occurrences(send, auditedTail) !== 2
  ) {
    errors.push(
      "both transfer proposal paths must consume the audited lock and version decisions",
    );
  }

  const wallet = normalizedRust(snapshot.files[WALLET_SOURCE]);
  const birthdayFormatter = [
    "pub(crate) fn format_birthday_error(error: BirthdayError) -> String {",
    "match error {",
    'BirthdayError::HeightInvalid(error) => format!("invalid height: {error}"),',
    'BirthdayError::Decode(error) => format!("decode error: {error}"),',
    "other => other.to_string(),",
    "}",
    "}",
  ].join(" ");
  if (
    occurrences(wallet, "pub(crate) fn format_birthday_error(") !== 1 ||
    occurrences(wallet, birthdayFormatter) !== 1
  ) {
    errors.push(
      "BirthdayError formatter must preserve known context and a future-variant wildcard",
    );
  }

  for (const lockfile of scope.lockfiles) {
    const versions = packageVersions(snapshot.files[lockfile], scope.packages);
    for (const [name, expected] of scope.packages) {
      const found = versions.get(name) ?? [];
      if (found.length !== 1 || found[0] !== expected) {
        errors.push(
          `${lockfile}: ${name} must occur once at reviewed version ${expected}, got ${found.join(",") || "missing"}`,
        );
      }
    }
  }
  return errors;
}

function liveSnapshot() {
  const files = Object.fromEntries(
    [SEND_SOURCE, WALLET_SOURCE, ...LOCKFILES].map((relative) => [
      relative,
      fs.readFileSync(path.join(REPO_ROOT, relative), "utf8"),
    ]),
  );
  const stage = execFileSync(
    "git",
    ["ls-files", "--stage", "--", SUBMODULE_PATH],
    { cwd: REPO_ROOT, encoding: "utf8" },
  ).trim();
  const match = stage.match(/^160000 ([0-9a-f]{40}) 0\t/);
  return { files, gitlink: match?.[1] ?? `invalid index entry: ${stage}` };
}

function replaceOnce(source, target, replacement, mutation) {
  const first = source.indexOf(target);
  const last = source.lastIndexOf(target);
  if (first < 0 || first !== last) {
    throw new Error(
      `${mutation}: mutation target must occur exactly once, found ${first < 0 ? 0 : "multiple"}`,
    );
  }
  return source.slice(0, first) + replacement + source.slice(first + target.length);
}

function mutated(snapshot, file, target, replacement, mutation) {
  return {
    ...snapshot,
    files: {
      ...snapshot.files,
      [file]: replaceOnce(
        snapshot.files[file],
        target,
        replacement,
        mutation,
      ),
    },
  };
}

function requireFailure(name, snapshot, expected, scope) {
  const errors = validate(snapshot, scope);
  if (!errors.some((error) => error.includes(expected))) {
    throw new Error(
      `${name}: mutant survived; expected ${JSON.stringify(expected)}, got ${JSON.stringify(errors)}`,
    );
  }
  process.stdout.write(`self-test: killed ${name}\n`);
}

function runSelfTest() {
  const baseline = liveSnapshot();
  const baselineErrors = validate(baseline);
  if (baselineErrors.length) {
    throw new Error(`baseline must pass: ${baselineErrors.join("; ")}`);
  }

  const allLocksDrift = LOCKFILES.reduce(
    (snapshot, lockfile) =>
      mutated(
        snapshot,
        lockfile,
        'name = "orchard"\nversion = "0.15.3"',
        'name = "orchard"\nversion = "0.15.4"',
        `all locks drift together (${lockfile})`,
      ),
    baseline,
  );
  const lockPackageDrifts = LOCKFILES.flatMap((lockfile) =>
    [...EXPECTED_PACKAGES].map(([name, version]) => [
      `${lockfile}: ${name} version drift`,
      mutated(
        baseline,
        lockfile,
        `name = "${name}"\nversion = "${version}"`,
        `name = "${name}"\nversion = "${version}-mutant"`,
        `${lockfile}: ${name} version drift`,
      ),
      `${lockfile}: ${name} must occur once`,
    ]),
  );
  const missingPackage = mutated(
    baseline,
    LOCKFILES[0],
    'name = "orchard"\nversion = "0.15.3"',
    'name = "orchard-missing"\nversion = "0.15.3"',
    "representative package missing",
  );
  const duplicatePackage = {
    ...baseline,
    files: {
      ...baseline.files,
      [LOCKFILES[0]]:
        `${baseline.files[LOCKFILES[0]].trimEnd()}\n\n` +
        '[[package]]\nname = "orchard"\nversion = "0.15.3"\n',
    },
  };
  const scopeMutants = [
    ...LOCKFILES.map((lockfile) => [
      `guarded scope drops ${lockfile}`,
      baseline,
      "reviewed scope must contain exactly 3 shipping locks",
      {
        lockfiles: LOCKFILES.filter((candidate) => candidate !== lockfile),
        packages: new Map(EXPECTED_PACKAGES),
      },
    ]),
    ...[...EXPECTED_PACKAGES].map(([name]) => [
      `guarded scope drops package ${name}`,
      baseline,
      "reviewed scope must contain exactly 11 packages",
      {
        lockfiles: [...LOCKFILES],
        packages: new Map(
          [...EXPECTED_PACKAGES].filter(([candidate]) => candidate !== name),
        ),
      },
    ]),
    [
      "guarded package inventory changes without changing its count",
      baseline,
      "reviewed lock/package scope digest",
      {
        lockfiles: [...LOCKFILES],
        packages: new Map(
          [...EXPECTED_PACKAGES].map(([name, version]) => [
            name,
            name === "orchard" ? `${version}-scope-mutant` : version,
          ]),
        ),
      },
    ],
  ];
  const cases = [
    [
      "LockRequest helper drift",
      mutated(
        baseline,
        SEND_SOURCE,
        "fn proposal_lock_request() -> Option<LockRequest> {",
        "fn proposal_lock_request() -> Option<LockRequest> { panic!(\"mutant\");",
        "LockRequest helper drift",
      ),
      "proposal lock decision",
    ],
    [
      "TxVersion helper drift",
      mutated(
        baseline,
        SEND_SOURCE,
        "fn proposed_transaction_version() -> Option<TxVersion> {",
        "fn proposed_transaction_version() -> Option<TxVersion> { panic!(\"mutant\");",
        "TxVersion helper drift",
      ),
      "transaction version decision",
    ],
    [
      "primary send bypasses audited helpers",
      mutated(
        baseline,
        SEND_SOURCE,
        "            proposal_lock_request(),\n            proposed_transaction_version(),",
        "            None,\n            None,",
        "primary send bypasses audited helpers",
      ),
      "both transfer proposal paths",
    ],
    [
      "send-all bypasses audited helpers",
      mutated(
        baseline,
        SEND_SOURCE,
        "                proposal_lock_request(),\n                proposed_transaction_version(),",
        "                None,\n                None,",
        "send-all bypasses audited helpers",
      ),
      "both transfer proposal paths",
    ],
    [
      "known BirthdayError context disappears",
      mutated(
        baseline,
        WALLET_SOURCE,
        'format!("invalid height: {error}")',
        "error.to_string()",
        "known BirthdayError context disappears",
      ),
      "BirthdayError formatter",
    ],
    [
      "BirthdayError Decode context disappears",
      mutated(
        baseline,
        WALLET_SOURCE,
        'format!("decode error: {error}")',
        "error.to_string()",
        "BirthdayError Decode context disappears",
      ),
      "BirthdayError formatter",
    ],
    [
      "BirthdayError wildcard disappears behind a comment",
      mutated(
        baseline,
        WALLET_SOURCE,
        "        other => other.to_string(),",
        "        // other => other.to_string(),",
        "BirthdayError wildcard disappears behind a comment",
      ),
      "BirthdayError formatter",
    ],
    [
      "stale librustzcash gitlink",
      { ...baseline, gitlink: "6cfb3857d248428cb53c7fb1f2b60ba15d5298a1" },
      "librustzcash gitlink",
    ],
    ...lockPackageDrifts,
    [
      "all locks drift together",
      allLocksDrift,
      "orchard must occur once at reviewed version 0.15.3",
    ],
    [
      "representative package missing",
      missingPackage,
      `${LOCKFILES[0]}: orchard must occur once`,
    ],
    [
      "representative package duplicated",
      duplicatePackage,
      `${LOCKFILES[0]}: orchard must occur once`,
    ],
    ...scopeMutants,
  ];
  for (const [name, snapshot, expected, scope] of cases) {
    requireFailure(name, snapshot, expected, scope);
  }
  process.stdout.write(`self-test: killed ${cases.length} compatibility mutants.\n`);
}

function runCli(args) {
  if (args.length === 1 && args[0] === "--self-test") {
    runSelfTest();
  } else if (args.length === 1 && args[0] === "--print-scope-digest") {
    process.stdout.write(
      `${createHash("sha256").update(compatibilityScopeIdentity()).digest("hex")}\n`,
    );
  } else if (args.length === 0) {
    const errors = validate(liveSnapshot());
    if (errors.length) {
      for (const error of errors) process.stderr.write(`drift: ${error}\n`);
      process.exit(1);
    }
    process.stdout.write(
      `librustzcash source contract passed: gitlink ${EXPECTED_LIBRUSTZCASH_SHA}, ` +
        `${EXPECTED_PACKAGES.size} reviewed packages across ${LOCKFILES.length} shipping locks.\n`,
    );
  } else {
    process.stderr.write(
      "usage: scripts/check-librustzcash-compat.mjs [--self-test|--print-scope-digest]\n",
    );
    process.exit(2);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2));
}
