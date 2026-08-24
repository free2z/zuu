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
const NATIVE_SEND_POLICY_SOURCE =
  "wallet/plugins/tauri-plugin-zcash/src/wallet/send/native.rs";
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

function rustFunctionBody(source, name) {
  const marker = `fn ${name}<`;
  if (occurrences(source, marker) !== 1) return null;

  const declaration = source.indexOf(marker);
  const bodyStart = source.indexOf("{", declaration + marker.length);
  if (bodyStart < 0) return null;

  let depth = 1;
  for (let index = bodyStart + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart + 1, index).trim();
  }
  return null;
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

  const orchestrationSource = snapshot.files[SEND_SOURCE];
  const nativePolicySource = snapshot.files[NATIVE_SEND_POLICY_SOURCE];
  const outsidePolicySource = snapshot.policyAuthorityPeers
    .map((relative) => snapshot.files[relative])
    .join("\n");
  const send = normalizedRust(nativePolicySource);
  const orchestration = normalizedRust(orchestrationSource);

  if (
    occurrences(orchestrationSource, "mod native;") !== 1 ||
    occurrences(orchestrationSource, "pub mod native;") !== 0
  ) {
    errors.push(
      "native send policy must remain in one private child module",
    );
  }
  const forbiddenOutsidePolicyModule = [
    "CreateErrT",
    "DustOutputPolicy",
    "GreedyInputSelector",
    "LockRequest",
    "OvkPolicy",
    "ProposeTransferErrT",
    "SingleOutputChangeStrategy",
    "SpendPolicy",
    "TxVersion",
    "Zip317FeeRule",
    "create_proposed_transactions",
    "propose_transfer",
  ];
  for (const symbol of forbiddenOutsidePolicyModule) {
    if (occurrences(outsidePolicySource, symbol) !== 0) {
      errors.push(
        `${symbol} must remain inaccessible outside the private native send policy module`,
      );
    }
  }
  const allowedPolicyExports = [
    "pub(super) fn create_transactions<",
    "pub(super) fn propose_fixed<",
    "pub(super) fn propose_send_all_attempt<",
  ];
  if (
    occurrences(send, "pub(super)") !== allowedPolicyExports.length ||
    allowedPolicyExports.some((declaration) => occurrences(send, declaration) !== 1) ||
    occurrences(send, "pub(crate)") !== 0 ||
    occurrences(send, "pub(in ") !== 0 ||
    occurrences(send, "pub ") !== 0
  ) {
    errors.push(
      "private native send policy module must expose only its three audited safe boundaries",
    );
  }
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
  const sharedProposalCore = rustFunctionBody(
    send,
    "propose_with_policy",
  );
  const defaultProposalBoundary = rustFunctionBody(send, "propose_default");
  const fixedSendBoundary = rustFunctionBody(send, "propose_fixed");
  const sendAllBoundary = rustFunctionBody(
    send,
    "propose_send_all_attempt",
  );
  const auditedTail =
    "request, ConfirmationsPolicy::default(), spend_policy, proposal_lock_request(), proposed_transaction_version(),";
  if (
    sharedProposalCore === null ||
    occurrences(send, "propose_transfer::<") !== 1 ||
    occurrences(sharedProposalCore ?? "", "propose_transfer::<") !== 1 ||
    occurrences(sharedProposalCore ?? "", auditedTail) !== 1
  ) {
    errors.push(
      "the shared proposal core must remain the only direct propose_transfer authority and consume the exact audited depth, spend, lock, and version decisions",
    );
  }
  const defaultPolicyCall =
    "propose_with_policy(db, params, account_id, request, &SpendPolicy::default())";
  if (
    defaultProposalBoundary === null ||
    occurrences(defaultProposalBoundary ?? "", defaultPolicyCall) !== 1 ||
    occurrences(send, defaultPolicyCall) !== 1
  ) {
    errors.push(
      "the default native-send boundary must enter the shared proposal core exactly once",
    );
  }
  const sharedDefaultCall =
    "propose_default(db, params, account_id, request)";
  if (
    fixedSendBoundary === null ||
    sendAllBoundary === null ||
    occurrences(fixedSendBoundary ?? "", sharedDefaultCall) !== 1 ||
    occurrences(sendAllBoundary ?? "", sharedDefaultCall) !== 1 ||
    occurrences(send, sharedDefaultCall) !== 2
  ) {
    errors.push(
      "fixed send and send-all must each delegate exactly once to the shared default proposal boundary",
    );
  }
  for (const [boundary, call] of [
    ["fixed send", "propose_fixed(db, &state.network, account_id, request)"],
    [
      "send-all",
      "propose_send_all_attempt(db, &state.network, account_id, request)",
    ],
    ["transaction creation", "create_transactions("],
  ]) {
    if (occurrences(orchestration, call) !== 1) {
      errors.push(
        `${boundary} orchestration must enter its only accessible native send boundary exactly once`,
      );
    }
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
  const policyAuthorityPeers = execFileSync(
    "git",
    [
      "ls-files",
      "--",
      ":(glob)wallet/plugins/tauri-plugin-zcash/src/**/*.rs",
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(
      (relative) =>
        relative.length > 0 && relative !== NATIVE_SEND_POLICY_SOURCE,
    );
  if (!policyAuthorityPeers.includes(SEND_SOURCE)) {
    throw new Error("native send authority census must include send orchestration");
  }
  const sourceFiles = [
    ...new Set([
      ...policyAuthorityPeers,
      NATIVE_SEND_POLICY_SOURCE,
      WALLET_SOURCE,
      ...LOCKFILES,
    ]),
  ];
  const files = Object.fromEntries(
    sourceFiles.map((relative) => [
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
  return {
    files,
    gitlink: match?.[1] ?? `invalid index entry: ${stage}`,
    policyAuthorityPeers,
  };
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

function mutatedOccurrence(
  snapshot,
  file,
  target,
  replacement,
  occurrence,
  expectedCount,
  mutation,
) {
  const source = snapshot.files[file];
  const offsets = [];
  let offset = 0;
  while ((offset = source.indexOf(target, offset)) !== -1) {
    offsets.push(offset);
    offset += target.length;
  }
  if (offsets.length !== expectedCount || occurrence >= offsets.length) {
    throw new Error(
      `${mutation}: mutation target must occur exactly ${expectedCount} time(s), found ${offsets.length}`,
    );
  }
  const selected = offsets[occurrence];
  return {
    ...snapshot,
    files: {
      ...snapshot.files,
      [file]:
        source.slice(0, selected) +
        replacement +
        source.slice(selected + target.length),
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
      "native send policy module becomes public",
      mutated(
        baseline,
        SEND_SOURCE,
        "mod native;",
        "pub mod native;",
        "native send policy module becomes public",
      ),
      "one private child module",
    ],
    [
      "private policy core becomes parent-visible",
      mutated(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
        "fn propose_with_policy<",
        "pub(super) fn propose_with_policy<",
        "private policy core becomes parent-visible",
      ),
      "expose only its three audited safe boundaries",
    ],
    [
      "fixed safe boundary loses parent visibility",
      mutated(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
        "pub(super) fn propose_fixed<",
        "fn propose_fixed<",
        "fixed safe boundary loses parent visibility",
      ),
      "expose only its three audited safe boundaries",
    ],
    [
      "policy module re-exports a policy type",
      mutated(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
        "use zcash_client_backend::fees::DustOutputPolicy;",
        "use zcash_client_backend::fees::DustOutputPolicy;\npub(super) use zcash_client_backend::data_api::wallet::input_selection::SpendPolicy as ExposedSpendPolicy;",
        "policy module re-exports a policy type",
      ),
      "expose only its three audited safe boundaries",
    ],
    [
      "parent imports a forbidden policy type",
      mutated(
        baseline,
        SEND_SOURCE,
        "use native::{create_transactions, propose_fixed, propose_send_all_attempt};",
        "use native::{create_transactions, propose_fixed, propose_send_all_attempt};\nuse zcash_client_backend::data_api::wallet::input_selection::SpendPolicy;",
        "parent imports a forbidden policy type",
      ),
      "SpendPolicy must remain inaccessible",
    ],
    [
      "parent aliases direct proposal authority",
      mutated(
        baseline,
        SEND_SOURCE,
        "use native::{create_transactions, propose_fixed, propose_send_all_attempt};",
        "use native::{create_transactions, propose_fixed, propose_send_all_attempt};\nuse zcash_client_backend::data_api::wallet::propose_transfer as aliased_proposal;",
        "parent aliases direct proposal authority",
      ),
      "propose_transfer must remain inaccessible",
    ],
    [
      "fixed orchestration drops its only safe boundary",
      mutated(
        baseline,
        SEND_SOURCE,
        "propose_fixed(db, &state.network, account_id, request)",
        "propose_send_all_attempt(db, &state.network, account_id, request)",
        "fixed orchestration drops its only safe boundary",
      ),
      "fixed send orchestration",
    ],
    [
      "send-all orchestration drops its only safe boundary",
      mutated(
        baseline,
        SEND_SOURCE,
        "propose_send_all_attempt(db, &state.network, account_id, request)",
        "propose_fixed(db, &state.network, account_id, request)",
        "send-all orchestration drops its only safe boundary",
      ),
      "send-all orchestration",
    ],
    [
      "LockRequest helper drift",
      mutated(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
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
        NATIVE_SEND_POLICY_SOURCE,
        "fn proposed_transaction_version() -> Option<TxVersion> {",
        "fn proposed_transaction_version() -> Option<TxVersion> { panic!(\"mutant\");",
        "TxVersion helper drift",
      ),
      "transaction version decision",
    ],
    [
      "shared proposal core is no longer recognizable",
      mutated(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
        "fn propose_with_policy<",
        "fn propose_with_policy_mutant<",
        "shared proposal core is no longer recognizable",
      ),
      "shared proposal core",
    ],
    [
      "a duplicated direct proposal path revives the old split authority",
      mutated(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
        "    propose_transfer::<_, _, _, _, zcash_client_sqlite::wallet::commitment_tree::Error>(",
        "    propose_transfer::<_, _, _, _, zcash_client_sqlite::wallet::commitment_tree::Error>(\n    propose_transfer::<_, _, _, _, zcash_client_sqlite::wallet::commitment_tree::Error>(",
        "a duplicated direct proposal path revives the old split authority",
      ),
      "only direct propose_transfer authority",
    ],
    [
      "shared proposal core bypasses the exact lock decision",
      mutated(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
        "        proposal_lock_request(),\n",
        "        None,\n",
        "shared proposal core bypasses the exact lock decision",
      ),
      "exact audited depth, spend, lock, and version decisions",
    ],
    [
      "shared proposal core bypasses the exact version decision",
      mutated(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
        "        proposed_transaction_version(),\n",
        "        None,\n",
        "shared proposal core bypasses the exact version decision",
      ),
      "exact audited depth, spend, lock, and version decisions",
    ],
    [
      "default policy boundary bypasses the shared proposal core",
      mutated(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
        "fn propose_default<",
        "fn propose_default_mutant<",
        "default policy boundary bypasses the shared proposal core",
      ),
      "default native-send boundary",
    ],
    [
      "fixed send bypasses the shared default boundary",
      mutatedOccurrence(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
        "    propose_default(db, params, account_id, request)",
        "    propose_with_policy(db, params, account_id, request, &SpendPolicy::default())",
        0,
        2,
        "fixed send bypasses the shared default boundary",
      ),
      "fixed send and send-all",
    ],
    [
      "send-all bypasses the shared default boundary",
      mutatedOccurrence(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
        "    propose_default(db, params, account_id, request)",
        "    propose_with_policy(db, params, account_id, request, &SpendPolicy::default())",
        1,
        2,
        "send-all bypasses the shared default boundary",
      ),
      "fixed send and send-all",
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
