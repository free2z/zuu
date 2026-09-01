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
//
// TRANSIENT FORK. This commit is upstream `main` at
// 91f448b5b1eacba09607faefd39e2204e4bb342d — the fork branch rebased forward
// from its previous base 330e4c0aa9e25199acdb93a56bf70126d0d3f2b9 — plus
// one 4-line deletion, and `.gitmodules` points at free2z/librustzcash for as
// long as that deletion is unmerged. It removes the workspace's
// `block-buffer = "=0.11.0-rc.3"` / `crypto-common = "=0.2.0-rc.1"` pins and
// the two `zcash_primitives` lines that consume them; both carry upstream's own
// "later RCs require edition2024" / "remove after edition2024 upgrade" comments,
// that upgrade has landed, and neither crate is named anywhere in
// zcash_primitives' source. `=0.2.0-rc.1` and the `^0.2` that `digest 0.11`
// requires cannot both be satisfied, which is what stopped
// `wallet/zuuli/src-tauri` linking `tauri-plugin-f2zmsg` at all.
//
// Because the delta is a dependency-requirement deletion and not a version
// bump, EXPECTED_PACKAGES below is unchanged and so is REVIEWED_SCOPE_DIGEST.
// The ten upstream commits this rebase pulls in (NuTachyon/V7 behind
// `cfg(zcash_unstable)`, transparent-output persistence, a P2PKH
// `finalize_spends` fix) published no new crate versions and changed no
// workspace dependency requirement, so all three shipping locks re-resolved
// byte-identically. Move both this literal and `.gitmodules` back to upstream
// the moment the PR merges.
const EXPECTED_LIBRUSTZCASH_SHA =
  "a2b8c95210046eb59ee71dd10fd2ad1e9329b238";
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

function rustCodeOnly(source, stripLiterals = true) {
  const masked = (value) => value.replace(/[^\r\n]/g, " ");
  const projectedLiteral = (value) =>
    stripLiterals ? masked(value) : value;
  const identifier = (value) => /[A-Za-z0-9_]/.test(value ?? "");
  const rawStringAt = (index) => {
    if (identifier(source[index - 1])) return null;
    let prefixLength = 0;
    if (source[index] === "r") prefixLength = 1;
    if (
      (source[index] === "b" || source[index] === "c") &&
      source[index + 1] === "r"
    ) {
      prefixLength = 2;
    }
    if (prefixLength === 0) return null;

    let cursor = index + prefixLength;
    while (source[cursor] === "#") cursor += 1;
    if (source[cursor] !== '"') return null;
    const hashes = cursor - index - prefixLength;
    if (hashes > 255) {
      throw new Error(
        `malformed Rust raw string at byte ${index}: more than 255 hashes`,
      );
    }
    return { content: cursor + 1, hashes };
  };
  const quotedEnd = (quote, label) => {
    for (let cursor = quote + 1; cursor < source.length; cursor += 1) {
      if (source[cursor] === "\\") {
        if (cursor + 1 >= source.length) {
          throw new Error(`unterminated Rust ${label} at byte ${quote}`);
        }
        cursor += 1;
      } else if (source[cursor] === '"') {
        return cursor + 1;
      }
    }
    throw new Error(`unterminated Rust ${label} at byte ${quote}`);
  };
  const characterEnd = (quote, label, required) => {
    let cursor = quote + 1;
    if (source[cursor] === "\\") {
      cursor += 1;
      if (source[cursor] === "x") {
        cursor += 3;
      } else if (source[cursor] === "u" && source[cursor + 1] === "{") {
        const brace = source.indexOf("}", cursor + 2);
        if (brace < 0) {
          throw new Error(`unterminated Rust ${label} at byte ${quote}`);
        }
        cursor = brace + 1;
      } else {
        cursor += 1;
      }
    } else {
      const point = source.codePointAt(cursor);
      if (point !== undefined) cursor += point > 0xffff ? 2 : 1;
    }
    if (source[cursor] === "'") return cursor + 1;
    if (required) {
      throw new Error(`malformed Rust ${label} at byte ${quote}`);
    }
    return null;
  };

  let output = "";
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index + 2);
      const boundary = end < 0 ? source.length : end;
      output += masked(source.slice(index, boundary));
      index = boundary;
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < source.length && depth > 0) {
        if (source.startsWith("/*", cursor)) {
          depth += 1;
          cursor += 2;
        } else if (source.startsWith("*/", cursor)) {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      if (depth !== 0) {
        throw new Error(`unterminated Rust block comment at byte ${index}`);
      }
      output += masked(source.slice(index, cursor));
      index = cursor;
      continue;
    }

    const raw = rawStringAt(index);
    if (raw !== null) {
      const closing = `"${"#".repeat(raw.hashes)}`;
      const close = source.indexOf(closing, raw.content);
      if (close < 0) {
        throw new Error(`unterminated Rust raw string at byte ${index}`);
      }
      const end = close + closing.length;
      output += projectedLiteral(source.slice(index, end));
      index = end;
      continue;
    }

    const prefixedLiteral =
      !identifier(source[index - 1]) &&
      (source[index] === "b" || source[index] === "c");
    if (source[index] === '"' || (prefixedLiteral && source[index + 1] === '"')) {
      const quote = source[index] === '"' ? index : index + 1;
      const end = quotedEnd(quote, "string");
      output += projectedLiteral(source.slice(index, end));
      index = end;
      continue;
    }
    if (prefixedLiteral && source[index + 1] === "'") {
      const end = characterEnd(index + 1, "byte character", true);
      output += projectedLiteral(source.slice(index, end));
      index = end;
      continue;
    }
    if (source[index] === "'") {
      const end = characterEnd(index, "character", false);
      if (end !== null) {
        output += projectedLiteral(source.slice(index, end));
        index = end;
        continue;
      }
    }

    output += source[index];
    index += 1;
  }
  return output;
}

function normalizedRust(source) {
  return rustCodeOnly(source).replace(/\s+/g, " ").trim();
}

function normalizedRustWithLiterals(source) {
  return rustCodeOnly(source, false).replace(/\s+/g, " ").trim();
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
  const markers = [`fn ${name}<`, `fn ${name}(`];
  const declarations = [];
  for (const marker of markers) {
    let offset = 0;
    while ((offset = source.indexOf(marker, offset)) !== -1) {
      declarations.push({ offset, marker });
      offset += marker.length;
    }
  }
  if (declarations.length !== 1) return null;

  const [{ offset: declaration, marker }] = declarations;
  const bodyStart = source.indexOf("{", declaration + marker.length);
  if (bodyStart < 0) return null;
  let bracketDepth = 0;
  for (
    let index = declaration + marker.length;
    index < bodyStart;
    index += 1
  ) {
    if (source[index] === "[") bracketDepth += 1;
    if (source[index] === "]") bracketDepth -= 1;
    if (source[index] === ";" && bracketDepth === 0) return null;
  }

  let depth = 1;
  for (let index = bodyStart + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart + 1, index).trim();
  }
  return null;
}

function rustBodyDigest(body) {
  return createHash("sha256").update(body).digest("hex");
}

function exactAdapterControlFlowErrors(body, contract) {
  const errors = [];
  if (body === null) {
    return [`${contract.boundary} must remain a unique Rust function body`];
  }
  if (/\bcfg\s*!?\s*\(/.test(body)) {
    errors.push(
      `${contract.boundary} must compile one control-flow body in tests, probes, and shipping builds`,
    );
  }

  let cursor = 0;
  for (const anchor of contract.orderedAnchors) {
    const count = occurrences(body, anchor);
    const index = body.indexOf(anchor, cursor);
    if (count !== 1 || index < cursor) {
      errors.push(
        `${contract.boundary} must preserve its ordered ${contract.transition} control flow`,
      );
      break;
    }
    cursor = index + anchor.length;
  }

  const digest = rustBodyDigest(body);
  if (digest !== contract.digest) {
    errors.push(
      `${contract.boundary} complete control-flow body must remain ${contract.digest}, got ${digest}`,
    );
  }
  return errors;
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
  let malformedRust = false;
  const normalize = (relative, source, keepLiterals = false) => {
    try {
      return keepLiterals
        ? normalizedRustWithLiterals(source)
        : normalizedRust(source);
    } catch (error) {
      malformedRust = true;
      errors.push(`${relative}: ${error.message}`);
      return "";
    }
  };
  const send = normalize(NATIVE_SEND_POLICY_SOURCE, nativePolicySource);
  const orchestration = normalize(SEND_SOURCE, orchestrationSource);
  const outsidePolicySource = snapshot.policyAuthorityPeers
    .map((relative) => normalize(relative, snapshot.files[relative]))
    .join("\n");
  if (malformedRust) return errors;

  const nativeModuleDeclarations = rustCodeOnly(orchestrationSource)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\bmod\s+native\s*;/.test(line));
  if (
    nativeModuleDeclarations.length !== 1 ||
    nativeModuleDeclarations[0] !== "mod native;"
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
    "pub(super) fn propose_fixed_validated<",
    "pub(super) fn propose_send_all_validated<",
    "pub(super) fn standard_minimum_fee(",
    "pub(super) fn wallet_summary_with_policy<",
  ];
  // Comments are whitespace in Rust and are already masked above. Canonicalize
  // visibility token spacing before counting so `pub(super /* comment */)`
  // cannot make a parent-visible policy function look private to this guard.
  const visibilityCanonical = send
    .replace(/\bpub\s*\(\s*super\s*\)/g, "pub(super)")
    .replace(/\bpub\s*\(\s*crate\s*\)/g, "pub(crate)")
    .replace(/\bpub\s*\(\s*in\s+/g, "pub(in ");
  if (
    occurrences(visibilityCanonical, "pub(super)") !==
      allowedPolicyExports.length ||
    allowedPolicyExports.some(
      (declaration) => occurrences(visibilityCanonical, declaration) !== 1,
    ) ||
    occurrences(visibilityCanonical, "pub(crate)") !== 0 ||
    occurrences(visibilityCanonical, "pub(in ") !== 0 ||
    occurrences(visibilityCanonical, "pub ") !== 0
  ) {
    errors.push(
      "private native send policy module must expose only its five audited safe boundaries",
    );
  }
  const lockHelper =
    "fn proposal_lock_request() -> Option<LockRequest> { None }";
  const versionHelper =
    "fn proposed_transaction_version() -> Option<TxVersion> { None }";
  const confirmationsPolicyBody = rustFunctionBody(
    send,
    "confirmations_policy",
  );
  const walletSummaryPolicyBody = rustFunctionBody(
    send,
    "wallet_summary_with_policy",
  );
  const minimumFeeBody = rustFunctionBody(send, "standard_minimum_fee");
  if (
    occurrences(send, "fn proposal_lock_request()") !== 1 ||
    occurrences(send, lockHelper) !== 1
  ) {
    errors.push("proposal lock decision must remain one exact audited None helper");
  }
  if (confirmationsPolicyBody !== "ConfirmationsPolicy::default()") {
    errors.push(
      "confirmation depth must remain one shared native-send policy decision",
    );
  }
  if (
    walletSummaryPolicyBody !==
    "db.get_wallet_summary(confirmations_policy())"
  ) {
    errors.push(
      "send-all wallet summary must remain routed through the shared confirmation policy",
    );
  }
  if (
    minimumFeeBody !==
    "let rule = Zip317FeeRule::standard(); (rule.marginal_fee() * rule.grace_actions()).map(u64::from)"
  ) {
    errors.push(
      "send-all minimum fee must remain derived from the standard ZIP-317 fee rule",
    );
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
  const fixedSendBoundary = rustFunctionBody(send, "propose_fixed_validated");
  const sendAllBoundary = rustFunctionBody(
    send,
    "propose_send_all_validated",
  );
  // Bind the sole authority token to the complete audited invocation. Counting
  // `propose_transfer::<` and its argument tail independently would let a live
  // function-item reference vouch for a separate aliased call.
  const auditedDirectProposalCall = [
    "propose_transfer::<_, _, _, _, zcash_client_sqlite::wallet::commitment_tree::Error>(",
    "db,",
    "params,",
    "account_id,",
    "&input_selector,",
    "&change_strategy,",
    "request,",
    "confirmations_policy(),",
    "spend_policy,",
    "proposal_lock_request(),",
    "proposed_transaction_version(),",
    ")",
  ].join(" ");
  if (
    occurrences(send, "propose_transfer::<") !== 1 ||
    occurrences(sharedProposalCore ?? "", auditedDirectProposalCall) !== 1
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
    fixedSendBoundary !== sharedDefaultCall ||
    sendAllBoundary !== sharedDefaultCall ||
    occurrences(send, sharedDefaultCall) !== 2
  ) {
    errors.push(
      "fixed send and send-all must each delegate exactly once to the shared default proposal boundary",
    );
  }
  for (const [boundary, call] of [
    ["fixed send", "self::native::propose_fixed_validated("],
    [
      "send-all",
      "self::native::propose_send_all_validated(",
    ],
    ["transaction creation", "self::native::create_transactions("],
  ]) {
    if (occurrences(orchestration, call) !== 1) {
      errors.push(
        `${boundary} orchestration must enter its only accessible native send boundary exactly once`,
      );
    }
  }
  const fixedProductionRouteBody = rustFunctionBody(
    orchestration,
    "propose_fixed_production_route",
  );
  const sendAllProductionRouteBody = rustFunctionBody(
    orchestration,
    "propose_send_all_production_route",
  );
  const creationProductionRouteBody = rustFunctionBody(
    orchestration,
    "create_production_recovery_route",
  );
  const sendAllSpendableBody = rustFunctionBody(
    orchestration,
    "send_all_spendable_balance",
  );
  const sendAllStatefulBody = rustFunctionBody(
    orchestration,
    "propose_send_all_stateful_production_caller",
  );
  if (
    occurrences(orchestration, "ConfirmationsPolicy") !== 0 ||
    occurrences(
      sendAllSpendableBody ?? "",
      "self::native::wallet_summary_with_policy(db)",
    ) !== 1 ||
    occurrences(
      orchestration,
      "self::native::wallet_summary_with_policy(db)",
    ) !== 1
  ) {
    errors.push(
      "send-all spendable balance must consume the sole native confirmation policy",
    );
  }
  if (
    occurrences(
      sendAllStatefulBody ?? "",
      "let minimum_fee = self::native::standard_minimum_fee()",
    ) !== 1
  ) {
    errors.push(
      "send-all retry and minimum-balance guard must derive their estimate from the standard ZIP-317 fee authority",
    );
  }
  for (const [boundary, body] of [
    ["fixed-send", fixedProductionRouteBody],
    ["send-all", sendAllProductionRouteBody],
    ["transaction-creation", creationProductionRouteBody],
  ]) {
    if (body === null || /\bcfg\s*!?\s*\(/.test(body)) {
      errors.push(
        `${boundary} production route must compile identically in behavior tests and shipping builds`,
      );
    }
  }
  const fixedNativeRoute =
    "let proposal = self::native::propose_fixed_validated(db, params, account_id, amount, request) .map_err";
  if (
    occurrences(fixedProductionRouteBody ?? "", fixedNativeRoute) !== 1 ||
    occurrences(orchestration, fixedNativeRoute) !== 1
  ) {
    errors.push(
      "the behavior-tested fixed-send production route must own its only native proposal call",
    );
  }
  const sendAllNativeRoute =
    "match self::native::propose_send_all_validated(db, params, account_id, amount, request) {";
  if (
    occurrences(sendAllProductionRouteBody ?? "", sendAllNativeRoute) !== 1 ||
    occurrences(orchestration, sendAllNativeRoute) !== 1
  ) {
    errors.push(
      "the behavior-tested send-all production route must own its only native proposal call",
    );
  }
  const creationNativeRoute =
    "let txids = self::native::create_transactions(db, params, prover, spending_keys, proposal) .map_err";
  if (
    occurrences(creationProductionRouteBody ?? "", creationNativeRoute) !== 1 ||
    occurrences(orchestration, creationNativeRoute) !== 1
  ) {
    errors.push(
      "the behavior-tested transaction-creation production route must own its only native creation call",
    );
  }
  for (const [boundary, body, route] of [
    [
      "fixed-send stateful caller",
      rustFunctionBody(
        orchestration,
        "propose_fixed_stateful_production_caller",
      ),
      "propose_fixed_production_route(",
    ],
    [
      "send-all stateful caller",
      sendAllStatefulBody,
      "propose_send_all_production_route(",
    ],
    [
      "transaction-creation stateful caller",
      rustFunctionBody(
        orchestration,
        "execute_send_creation_stateful_production_caller",
      ),
      "create_production_recovery_route(",
    ],
  ]) {
    if (
      occurrences(body ?? "", route) !== 1 ||
      /\bcfg\s*!?\s*\(/.test(body ?? "")
    ) {
      errors.push(
        `${boundary} must be compiler-bound exactly once to its behavior-tested production route`,
      );
    }
  }
  // These are independently reviewed identities of the complete normalized
  // Rust bodies, not values derived from the live source into their expected
  // result. The ordered anchors make the money/state transitions readable;
  // the digest closes every unlisted control-flow gap before or after them.
  const adapterContracts = [
    {
      boundary: "fixed-send WalletState adapter",
      functionName: "propose_send_after_recipient_validation",
      transition: "proposal construction and accepted-state installation",
      digest: "a0606b0e0b3e8dcbec2c1a4fc322b36dd14296960fec98ca9023020e7cb6c7ca",
      orderedAnchors: [
        "let candidate = propose_fixed_stateful_production_caller( db, &state.network, &recipient, amount, memo_bytes.as_ref(), network_label(&state.network), &wallet_id, &state.proposal_counter, state.send_session_id, );",
        "drop(db_guard);",
        "let mut pending_broadcast = state.pending_broadcast.lock().await;",
        "ensure_no_unresolved_broadcast(pending_broadcast.as_ref())?;",
        "let mut proposal_guard = state.pending_proposal.lock().await;",
        "let result = install_accepted_proposal(&mut *proposal_guard, candidate);",
        "match result {",
        "*pending_broadcast = None; Ok(output)",
      ],
    },
    {
      boundary: "send-all WalletState adapter",
      functionName: "propose_send_all_after_recipient_validation",
      transition: "proposal construction and exact pending-state installation",
      digest: "1f9d5942f8ec8cfeafa9c1f5bd8c43c64f88c1f97476cda42a5db11bed49fd00",
      orderedAnchors: [
        "let spendable = { let db_guard = state.read_db.lock().await; let db = db_guard.as_ref().ok_or(Error::WalletNotInitialized)?; send_all_spendable_balance(db)? };",
        "let (pending, public) = propose_send_all_stateful_production_caller( db, &state.network, &recipient, memo_bytes.as_ref(), network_label(&state.network), spendable, &wallet_id, &state.proposal_counter, state.send_session_id, )?;",
        "drop(db_guard);",
        "let mut pending_broadcast = state.pending_broadcast.lock().await;",
        "ensure_no_unresolved_broadcast(pending_broadcast.as_ref())?;",
        "*state.pending_proposal.lock().await = Some(pending);",
        "*pending_broadcast = None;",
        "Ok(public)",
      ],
    },
    {
      boundary: "transaction execution WalletState adapter",
      functionName: "execute_send",
      transition: "creation, exact-byte persistence, and broadcast",
      digest: "f36decbe6b267c738c564a748f4ef4802b23cc6895123d3cc8b6f5cda5728913",
      orderedAnchors: [
        "persist_pending_broadcast(&state.data_dir, &intent)?;",
        "*broadcast_guard = Some(intent);",
        "let spending_keys = SpendingKeys::from_unified_spending_key(usk);",
        "execute_send_creation_stateful_production_caller( db, &state.network, prover, &spending_keys, &pending_proposal.proposal, &wallet_id, proposal_id, &mut broadcast_guard, || clear_pending_broadcast(&state.data_dir, &wallet_id), )?;",
        "let record = broadcast_guard .as_ref() .ok_or_else",
        "persist_pending_broadcast(&state.data_dir, record)?;",
        "drop(db_guard);",
        "drop(prover_guard);",
        "let record = broadcast_guard .as_mut() .ok_or_else",
        "broadcast_record(state, record).await",
      ],
    },
  ];
  for (const contract of adapterContracts) {
    errors.push(
      ...exactAdapterControlFlowErrors(
        rustFunctionBody(orchestration, contract.functionName),
        contract,
      ),
    );
  }
  const fixedOrchestrationBody = rustFunctionBody(
    orchestration,
    "propose_send",
  );
  const sendAllOrchestrationBody = rustFunctionBody(
    orchestration,
    "propose_send_all",
  );
  for (const [boundary, body, expectedBody] of [
    [
      "fixed send",
      fixedOrchestrationBody,
      [
        "let (recipient, _) = parse_recipient(&state.network, to)?;",
        "propose_send_after_recipient_validation(state, recipient, amount, memo).await",
      ].join(" "),
    ],
    [
      "send-all",
      sendAllOrchestrationBody,
      [
        "let (recipient, _) = parse_recipient(&state.network, to)?;",
        "propose_send_all_after_recipient_validation(state, recipient, memo).await",
      ].join(" "),
    ],
  ]) {
    if (body !== expectedBody) {
      errors.push(
        `${boundary} must validate its recipient as the sole path into proposal orchestration`,
      );
    }
  }

  const wallet = normalize(WALLET_SOURCE, snapshot.files[WALLET_SOURCE], true);
  if (malformedRust) return errors;
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

function runRustLexerSelfTest() {
  const route = "propose_transfer::<";
  const fixture = [
    `// ${route} line comment`,
    `/* ${route} outer /* ${route} nested */ comment */`,
    `let normal = "${route}";`,
    String.raw`let escaped = "escaped quote: \" ${route}";`,
    `let bytes = b"${route}";`,
    `let c_string = c"${route}";`,
    `let raw = r#"${route}"#;`,
    `let raw_hashes = r###"quote " and hash ## ${route}"###;`,
    `let raw_bytes = br##"quote " before ${route}"##;`,
    `let raw_c_string = cr#"quote " before ${route}"#;`,
    "let character = '{';",
    "let byte_character = b'}';",
    String.raw`let escaped_character = '\'';`,
    String.raw`let escaped_backslash = '\\';`,
    String.raw`let hex_byte_character = b'\x7b';`,
    String.raw`let unicode_character = '\u{7b}';`,
    "let astral_character = '🦀';",
    `fn visible<'a>(value: &'a str) { ${route}Visible>(); }`,
  ].join("\n");
  const projected = normalizedRust(fixture);
  if (occurrences(projected, route) !== 1) {
    throw new Error(
      `Rust lexical projection must retain only the live route, got ${JSON.stringify(projected)}`,
    );
  }
  if (occurrences(projected, "fn visible<'a>(value: &'a str)") !== 1) {
    throw new Error(
      "Rust lexical projection corrupted a lifetime while stripping characters",
    );
  }
  for (const literal of ["\\x7b", "\\u{7b}", "🦀"]) {
    if (projected.includes(literal)) {
      throw new Error(
        `Rust lexical projection failed to strip character literal ${JSON.stringify(literal)}`,
      );
    }
  }

  const malformed = [
    ['let value = "unterminated', "unterminated Rust string"],
    ['let value = r##"unterminated"#;', "unterminated Rust raw string"],
    ['let value = br#"unterminated', "unterminated Rust raw string"],
    ["let value = b'x;", "malformed Rust byte character"],
    ["/* unterminated", "unterminated Rust block comment"],
    [
      `let value = r${"#".repeat(256)}"invalid"${"#".repeat(256)};`,
      "more than 255 hashes",
    ],
  ];
  for (const [source, expected] of malformed) {
    let message = "";
    try {
      normalizedRust(source);
    } catch (error) {
      message = error.message;
    }
    if (!message.includes(expected)) {
      throw new Error(
        `malformed Rust must fail closed with ${JSON.stringify(expected)}, got ${JSON.stringify(message)}`,
      );
    }
  }
  process.stdout.write(
    `self-test: Rust lexical projection stripped comments/literals and rejected ${malformed.length} malformed inputs\n`,
  );
}

function runRustFunctionBodySelfTest() {
  const fixture = normalizedRust(`
    async fn plain() { before(); if ready() { nested(); } after(); }
    fn generic<T>() { direct(); }
    fn array(value: [u8; 32]) { exact(value); }
  `);
  if (
    rustFunctionBody(fixture, "plain") !==
      "before(); if ready() { nested(); } after();" ||
    rustFunctionBody(fixture, "generic") !== "direct();" ||
    rustFunctionBody(fixture, "array") !== "exact(value);"
  ) {
    throw new Error(
      "Rust function extraction must support plain/generic functions, array types, and nested blocks",
    );
  }
  if (rustFunctionBody(`${fixture} fn plain() { duplicate(); }`, "plain") !== null) {
    throw new Error("duplicate Rust function declarations must fail closed");
  }
  const declarationOnly = normalizedRust(
    "trait Contract { fn missing(); } fn later() { live(); }",
  );
  if (rustFunctionBody(declarationOnly, "missing") !== null) {
    throw new Error("a declaration without a body must fail closed");
  }
  if (rustFunctionBody("fn unbalanced() { live();", "unbalanced") !== null) {
    throw new Error("an unbalanced Rust function body must fail closed");
  }
  const missingBodyAfterPrior = normalizedRust("} fn missing()");
  if (rustFunctionBody(missingBodyAfterPrior, "missing") !== null) {
    throw new Error("a Rust function without any body delimiter must fail closed");
  }
  process.stdout.write(
    "self-test: Rust function extraction handled both declaration shapes and failed closed\n",
  );
}

function runSelfTest() {
  runRustLexerSelfTest();
  runRustFunctionBodySelfTest();
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
  const fixedAdapterCall = `    let candidate = propose_fixed_stateful_production_caller(
        db,
        &state.network,
        &recipient,
        amount,
        memo_bytes.as_ref(),
        network_label(&state.network),
        &wallet_id,
        &state.proposal_counter,
        state.send_session_id,
    );`;
  const sendAllAdapterCall = `    let (pending, public) = propose_send_all_stateful_production_caller(
        db,
        &state.network,
        &recipient,
        memo_bytes.as_ref(),
        network_label(&state.network),
        spendable,
        &wallet_id,
        &state.proposal_counter,
        state.send_session_id,
    )?;`;
  const executeAdapterCall = `    execute_send_creation_stateful_production_caller(
        db,
        &state.network,
        prover,
        &spending_keys,
        &pending_proposal.proposal,
        &wallet_id,
        proposal_id,
        &mut broadcast_guard,
        || clear_pending_broadcast(&state.data_dir, &wallet_id),
    )?;`;
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
    ...["pub(crate)", "pub(super)", "pub(in crate)"].map((visibility) => [
      `native send policy module gains ${visibility} visibility`,
      mutated(
        baseline,
        SEND_SOURCE,
        "mod native;",
        `${visibility} mod native;`,
        `native send policy module gains ${visibility} visibility`,
      ),
      "one private child module",
    ]),
    [
      "native send policy module declaration is duplicated",
      mutated(
        baseline,
        SEND_SOURCE,
        "mod native;",
        "mod native;\nmod native;",
        "duplicate native send policy module declaration",
      ),
      "one private child module",
    ],
    [
      "native send policy module declaration disappears",
      mutated(
        baseline,
        SEND_SOURCE,
        "mod native;",
        "// native module declaration removed",
        "remove native send policy module declaration",
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
      "expose only its five audited safe boundaries",
    ],
    [
      "comment spacing cannot hide parent-visible policy core",
      mutated(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
        "fn propose_with_policy<",
        "pub(super /* visibility mutant */) fn propose_with_policy<",
        "hide parent-visible policy core behind comment spacing",
      ),
      "expose only its five audited safe boundaries",
    ],
    [
      "fixed safe boundary loses parent visibility",
      mutated(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
        "pub(super) fn propose_fixed_validated<",
        "fn propose_fixed_validated<",
        "fixed safe boundary loses parent visibility",
      ),
      "expose only its five audited safe boundaries",
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
      "expose only its five audited safe boundaries",
    ],
    [
      "parent imports a forbidden policy type",
      mutated(
        baseline,
        SEND_SOURCE,
        "mod native;",
        "mod native;\nuse zcash_client_backend::data_api::wallet::input_selection::SpendPolicy;",
        "parent imports a forbidden policy type",
      ),
      "SpendPolicy must remain inaccessible",
    ],
    [
      "parent aliases direct proposal authority",
      mutated(
        baseline,
        SEND_SOURCE,
        "mod native;",
        "mod native;\nuse zcash_client_backend::data_api::wallet::propose_transfer as aliased_proposal;",
        "parent aliases direct proposal authority",
      ),
      "propose_transfer must remain inaccessible",
    ],
    [
      "fixed orchestration drops its only safe boundary",
      mutated(
        baseline,
        SEND_SOURCE,
        "self::native::propose_fixed_validated(",
        "self::native::propose_send_all_validated(",
        "fixed orchestration drops its only safe boundary",
      ),
      "fixed send orchestration",
    ],
    [
      "send-all orchestration drops its only safe boundary",
      mutated(
        baseline,
        SEND_SOURCE,
        "self::native::propose_send_all_validated(",
        "self::native::propose_fixed_validated(",
        "send-all orchestration drops its only safe boundary",
      ),
      "send-all orchestration",
    ],
    [
      "fixed validated route gates ordinary requests behind maximum amount",
      mutatedOccurrence(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
        "    propose_default(db, params, account_id, request)",
        "    if _validated_amount == u64::MAX {\n        propose_default(db, params, account_id, request)\n    } else {\n        panic!(\"mutant\")\n    }",
        0,
        2,
        "gate fixed validated route behind maximum amount",
      ),
      "fixed send and send-all must each delegate exactly once",
    ],
    [
      "send-all validated route gates ordinary requests behind maximum amount",
      mutatedOccurrence(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
        "    propose_default(db, params, account_id, request)",
        "    if _validated_amount == u64::MAX {\n        propose_default(db, params, account_id, request)\n    } else {\n        panic!(\"mutant\")\n    }",
        1,
        2,
        "gate send-all validated route behind maximum amount",
      ),
      "fixed send and send-all must each delegate exactly once",
    ],
    [
      "fixed production call gates ordinary requests behind maximum amount",
      mutated(
        baseline,
        SEND_SOURCE,
        "    let proposal =\n        self::native::propose_fixed_validated(db, params, account_id, amount, request)\n            .map_err(|error| Error::SendError(format!(\"failed to propose transfer: {error:?}\")))?;",
        "    let proposal = if amount == u64::MAX {\n        self::native::propose_fixed_validated(db, params, account_id, amount, request)\n            .map_err(|error| Error::SendError(format!(\"failed to propose transfer: {error:?}\")))?\n    } else {\n        panic!(\"mutant blocked ordinary fixed request\")\n    };",
        "gate fixed production call behind maximum amount",
      ),
      "behavior-tested fixed-send production route",
    ],
    [
      "fixed production route behaves differently under the test compiler",
      mutated(
        baseline,
        SEND_SOURCE,
        "    let request = single_payment_request(recipient, amount, memo)?;",
        "    if !cfg!(test) { panic!(\"shipping-only mutant\"); }\n    let request = single_payment_request(recipient, amount, memo)?;",
        "split fixed production behavior with cfg!(test)",
      ),
      "fixed-send production route must compile identically",
    ],
    [
      "fixed production helper is shadowed by a maximum-only function item",
      mutated(
        baseline,
        SEND_SOURCE,
        "    let proposal =\n        self::native::propose_fixed_validated(db, params, account_id, amount, request)\n            .map_err(|error| Error::SendError(format!(\"failed to propose transfer: {error:?}\")))?;",
        "    let propose_fixed = self::native::propose_fixed_validated;\n    let proposal = propose_fixed(db, params, account_id, amount, request)\n        .map_err(|error| Error::SendError(format!(\"failed to propose transfer: {error:?}\")))?;",
        "shadow fixed production helper with maximum-only function item",
      ),
      "fixed send orchestration must enter its only accessible native send boundary",
    ],
    [
      "send-all production call gates ordinary requests behind maximum amount",
      mutated(
        baseline,
        SEND_SOURCE,
        "    match self::native::propose_send_all_validated(db, params, account_id, amount, request) {",
        "    match if amount == u64::MAX {\n        self::native::propose_send_all_validated(db, params, account_id, amount, request)\n    } else {\n        panic!(\"mutant blocked ordinary send-all request\")\n    } {",
        "gate send-all production call behind maximum amount",
      ),
      "behavior-tested send-all production route",
    ],
    [
      "send-all production helper is shadowed by a maximum-only function item",
      mutated(
        baseline,
        SEND_SOURCE,
        "    match self::native::propose_send_all_validated(db, params, account_id, amount, request) {",
        "    let propose_send_all = self::native::propose_send_all_validated;\n    match propose_send_all(db, params, account_id, amount, request) {",
        "shadow send-all production helper with maximum-only function item",
      ),
      "send-all orchestration must enter its only accessible native send boundary",
    ],
    [
      "fixed stateful caller disconnects from its behavior-tested route",
      mutated(
        baseline,
        SEND_SOURCE,
        "    let (proposal, review) = propose_fixed_production_route(",
        "    let (proposal, review) = disconnected_fixed_route(",
        "disconnect fixed stateful caller from its behavior-tested route",
      ),
      "fixed-send stateful caller must be compiler-bound exactly once",
    ],
    [
      "send-all stateful caller disconnects from its behavior-tested route",
      mutated(
        baseline,
        SEND_SOURCE,
        "        match propose_send_all_production_route(",
        "        match disconnected_send_all_route(",
        "disconnect send-all stateful caller from its behavior-tested route",
      ),
      "send-all stateful caller must be compiler-bound exactly once",
    ],
    [
      "transaction-creation stateful caller disconnects from its behavior-tested route",
      mutated(
        baseline,
        SEND_SOURCE,
        "    match create_production_recovery_route(",
        "    match disconnected_creation_route(",
        "disconnect stateful creation caller from its behavior-tested route",
      ),
      "transaction-creation stateful caller must be compiler-bound exactly once",
    ],
    [
      "fixed WalletState adapter hides its caller behind the probe feature",
      mutated(
        baseline,
        SEND_SOURCE,
        fixedAdapterCall,
        `    let candidate = if cfg!(feature = "production-route-probe") {
        propose_fixed_stateful_production_caller(
            db,
            &state.network,
            &recipient,
            amount,
            memo_bytes.as_ref(),
            network_label(&state.network),
            &wallet_id,
            &state.proposal_counter,
            state.send_session_id,
        )
    } else {
        panic!("shipping fixed-send adapter bypassed its tested caller");
    };`,
        "feature-split fixed WalletState adapter",
      ),
      "fixed-send WalletState adapter must compile one control-flow body",
    ],
    [
      "send-all WalletState adapter hides its caller behind the probe feature",
      mutated(
        baseline,
        SEND_SOURCE,
        sendAllAdapterCall,
        `    let (pending, public) = if cfg!(feature = "production-route-probe") {
        propose_send_all_stateful_production_caller(
            db,
            &state.network,
            &recipient,
            memo_bytes.as_ref(),
            network_label(&state.network),
            spendable,
            &wallet_id,
            &state.proposal_counter,
            state.send_session_id,
        )
    } else {
        return Err(Error::SendError("shipping send-all adapter bypassed its tested caller".into()));
    }?;`,
        "feature-split send-all WalletState adapter",
      ),
      "send-all WalletState adapter must compile one control-flow body",
    ],
    [
      "execute WalletState adapter hides its caller behind the probe feature",
      mutated(
        baseline,
        SEND_SOURCE,
        executeAdapterCall,
        `    if cfg!(feature = "production-route-probe") {
        execute_send_creation_stateful_production_caller(
            db,
            &state.network,
            prover,
            &spending_keys,
            &pending_proposal.proposal,
            &wallet_id,
            proposal_id,
            &mut broadcast_guard,
            || clear_pending_broadcast(&state.data_dir, &wallet_id),
        )?;
    } else {
        return Err(Error::SendError("shipping execute adapter bypassed its tested caller".into()));
    }`,
        "feature-split execute WalletState adapter",
      ),
      "transaction execution WalletState adapter must compile one control-flow body",
    ],
    [
      "fixed WalletState adapter parks its caller in a dead branch",
      mutated(
        baseline,
        SEND_SOURCE,
        fixedAdapterCall,
        `    let candidate = if false {
        propose_fixed_stateful_production_caller(
            db,
            &state.network,
            &recipient,
            amount,
            memo_bytes.as_ref(),
            network_label(&state.network),
            &wallet_id,
            &state.proposal_counter,
            state.send_session_id,
        )
    } else {
        return Err(Error::SendError("fixed-send adapter parked its tested caller".into()));
    };`,
        "dead fixed WalletState adapter call",
      ),
      "fixed-send WalletState adapter complete control-flow body",
    ],
    [
      "send-all WalletState adapter parks its caller in a dead branch",
      mutated(
        baseline,
        SEND_SOURCE,
        sendAllAdapterCall,
        `    let (pending, public) = if false {
        propose_send_all_stateful_production_caller(
            db,
            &state.network,
            &recipient,
            memo_bytes.as_ref(),
            network_label(&state.network),
            spendable,
            &wallet_id,
            &state.proposal_counter,
            state.send_session_id,
        )
    } else {
        return Err(Error::SendError("send-all adapter parked its tested caller".into()));
    }?;`,
        "dead send-all WalletState adapter call",
      ),
      "send-all WalletState adapter complete control-flow body",
    ],
    [
      "execute WalletState adapter parks its caller before an early error",
      mutated(
        baseline,
        SEND_SOURCE,
        executeAdapterCall,
        `    if false {
        execute_send_creation_stateful_production_caller(
            db,
            &state.network,
            prover,
            &spending_keys,
            &pending_proposal.proposal,
            &wallet_id,
            proposal_id,
            &mut broadcast_guard,
            || clear_pending_broadcast(&state.data_dir, &wallet_id),
        )?;
    } else {
        return Err(Error::SendError("execute adapter parked its tested caller".into()));
    }`,
        "dead execute WalletState adapter call",
      ),
      "transaction execution WalletState adapter complete control-flow body",
    ],
    [
      "fixed WalletState adapter corrupts the reviewed fee after its caller",
      mutated(
        baseline,
        SEND_SOURCE,
        fixedAdapterCall,
        `${fixedAdapterCall.replace("let candidate =", "let mut candidate =")}
    if let Ok((_, public)) = &mut candidate {
        public.review.fee = 0;
    }`,
        "fixed WalletState adapter post-call fee corruption",
      ),
      "fixed-send WalletState adapter complete control-flow body",
    ],
    [
      "send-all WalletState adapter corrupts the reviewed fee after its caller",
      mutated(
        baseline,
        SEND_SOURCE,
        sendAllAdapterCall,
        `${sendAllAdapterCall.replace("let (pending, public)", "let (pending, mut public)")}
    public.review.fee = 0;`,
        "send-all WalletState adapter post-call fee corruption",
      ),
      "send-all WalletState adapter complete control-flow body",
    ],
    [
      "execute WalletState adapter corrupts retry bytes before persistence",
      mutated(
        baseline,
        SEND_SOURCE,
        executeAdapterCall,
        `${executeAdapterCall}
    if let Some(record) = broadcast_guard.as_mut() {
        record.raw_transaction[0] ^= 1;
    }`,
        "execute WalletState adapter post-call retry-byte corruption",
      ),
      "transaction execution WalletState adapter complete control-flow body",
    ],
    [
      "creation production helper is replaced by a local function item",
      mutated(
        baseline,
        SEND_SOURCE,
        "    let txids = self::native::create_transactions(db, params, prover, spending_keys, proposal)",
        "    let create = self::native::create_transactions;\n    let txids = create(db, params, prover, spending_keys, proposal)",
        "replace creation production helper with local function item",
      ),
      "transaction creation orchestration must enter its only accessible native send boundary",
    ],
    [
      "fixed send validates its recipient after proposal authority",
      mutated(
        baseline,
        SEND_SOURCE,
        "    let (recipient, _) = parse_recipient(&state.network, to)?;\n    propose_send_after_recipient_validation(state, recipient, amount, memo).await",
        "    let recipient = zcash_address::ZcashAddress::try_from_encoded(to).map_err(|_| Error::AddressError(\"invalid Zcash address\".into()))?;\n    let result = propose_send_after_recipient_validation(state, recipient, amount, memo).await;\n    let _ = parse_recipient(&state.network, to)?;\n    result",
        "move fixed-send recipient validation after proposal authority",
      ),
      "fixed send must validate its recipient as the sole path",
    ],
    [
      "fixed send drops recipient validation",
      mutated(
        baseline,
        SEND_SOURCE,
        "    let (recipient, _) = parse_recipient(&state.network, to)?;\n    propose_send_after_recipient_validation(state, recipient, amount, memo).await",
        "    let recipient = zcash_address::ZcashAddress::try_from_encoded(to).map_err(|_| Error::AddressError(\"invalid Zcash address\".into()))?;\n    propose_send_after_recipient_validation(state, recipient, amount, memo).await",
        "drop fixed-send recipient validation",
      ),
      "fixed send must validate its recipient as the sole path",
    ],
    [
      "fixed send inverts recipient validation",
      mutated(
        baseline,
        SEND_SOURCE,
        "    let (recipient, _) = parse_recipient(&state.network, to)?;\n    propose_send_after_recipient_validation(state, recipient, amount, memo).await",
        "    if parse_recipient(&state.network, to).is_ok() {\n        return Err(Error::AddressError(\"mutant rejected valid recipient\".into()));\n    }\n    let recipient = zcash_address::ZcashAddress::try_from_encoded(to).map_err(|_| Error::AddressError(\"invalid Zcash address\".into()))?;\n    propose_send_after_recipient_validation(state, recipient, amount, memo).await",
        "invert fixed-send recipient validation",
      ),
      "fixed send must validate its recipient as the sole path",
    ],
    [
      "fixed send parks recipient validation in a dead branch",
      mutated(
        baseline,
        SEND_SOURCE,
        "    let (recipient, _) = parse_recipient(&state.network, to)?;\n    propose_send_after_recipient_validation(state, recipient, amount, memo).await",
        "    if false { let _ = parse_recipient(&state.network, to)?; }\n    let recipient = zcash_address::ZcashAddress::try_from_encoded(to).map_err(|_| Error::AddressError(\"invalid Zcash address\".into()))?;\n    propose_send_after_recipient_validation(state, recipient, amount, memo).await",
        "park fixed-send recipient validation in a dead branch",
      ),
      "fixed send must validate its recipient as the sole path",
    ],
    [
      "send-all validates its recipient after proposal authority",
      mutated(
        baseline,
        SEND_SOURCE,
        "    let (recipient, _) = parse_recipient(&state.network, to)?;\n    propose_send_all_after_recipient_validation(state, recipient, memo).await",
        "    let recipient = zcash_address::ZcashAddress::try_from_encoded(to).map_err(|_| Error::AddressError(\"invalid Zcash address\".into()))?;\n    let result = propose_send_all_after_recipient_validation(state, recipient, memo).await;\n    let _ = parse_recipient(&state.network, to)?;\n    result",
        "move send-all recipient validation after proposal authority",
      ),
      "send-all must validate its recipient as the sole path",
    ],
    [
      "send-all drops recipient validation",
      mutated(
        baseline,
        SEND_SOURCE,
        "    let (recipient, _) = parse_recipient(&state.network, to)?;\n    propose_send_all_after_recipient_validation(state, recipient, memo).await",
        "    let recipient = zcash_address::ZcashAddress::try_from_encoded(to).map_err(|_| Error::AddressError(\"invalid Zcash address\".into()))?;\n    propose_send_all_after_recipient_validation(state, recipient, memo).await",
        "drop send-all recipient validation",
      ),
      "send-all must validate its recipient as the sole path",
    ],
    [
      "send-all inverts recipient validation",
      mutated(
        baseline,
        SEND_SOURCE,
        "    let (recipient, _) = parse_recipient(&state.network, to)?;\n    propose_send_all_after_recipient_validation(state, recipient, memo).await",
        "    if parse_recipient(&state.network, to).is_ok() {\n        return Err(Error::AddressError(\"mutant rejected valid recipient\".into()));\n    }\n    let recipient = zcash_address::ZcashAddress::try_from_encoded(to).map_err(|_| Error::AddressError(\"invalid Zcash address\".into()))?;\n    propose_send_all_after_recipient_validation(state, recipient, memo).await",
        "invert send-all recipient validation",
      ),
      "send-all must validate its recipient as the sole path",
    ],
    [
      "send-all parks recipient validation in a dead branch",
      mutated(
        baseline,
        SEND_SOURCE,
        "    let (recipient, _) = parse_recipient(&state.network, to)?;\n    propose_send_all_after_recipient_validation(state, recipient, memo).await",
        "    if false { let _ = parse_recipient(&state.network, to)?; }\n    let recipient = zcash_address::ZcashAddress::try_from_encoded(to).map_err(|_| Error::AddressError(\"invalid Zcash address\".into()))?;\n    propose_send_all_after_recipient_validation(state, recipient, memo).await",
        "park send-all recipient validation in a dead branch",
      ),
      "send-all must validate its recipient as the sole path",
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
      "shared confirmation policy drifts to minimum depth",
      mutated(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
        "    ConfirmationsPolicy::default()\n",
        "    ConfirmationsPolicy::MIN\n",
        "change the shared confirmation policy",
      ),
      "one shared native-send policy decision",
    ],
    [
      "wallet summary bypasses the shared confirmation policy",
      mutated(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
        "    db.get_wallet_summary(confirmations_policy())\n",
        "    db.get_wallet_summary(ConfirmationsPolicy::MIN)\n",
        "bypass shared depth inside the wallet-summary boundary",
      ),
      "wallet summary must remain routed through the shared confirmation policy",
    ],
    [
      "standard minimum fee becomes an independent literal",
      mutated(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
        "    (rule.marginal_fee() * rule.grace_actions()).map(u64::from)\n",
        "    Some(10_000)\n",
        "replace the fee-rule derivation with an independent literal",
      ),
      "derived from the standard ZIP-317 fee rule",
    ],
    [
      "proposal construction bypasses the shared confirmation policy",
      mutated(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
        "        confirmations_policy(),\n",
        "        ConfirmationsPolicy::default(),\n",
        "bypass shared depth in proposal construction",
      ),
      "exact audited depth, spend, lock, and version decisions",
    ],
    [
      "send-all balance bypasses the shared confirmation policy",
      mutated(
        baseline,
        SEND_SOURCE,
        "    let summary = self::native::wallet_summary_with_policy(db)\n",
        "    let summary = db\n        .get_wallet_summary(zcash_client_backend::data_api::wallet::ConfirmationsPolicy::default())\n",
        "bypass shared depth in send-all balance",
      ),
      "sole native confirmation policy",
    ],
    [
      "send-all retry revives the independent fee literal",
      mutated(
        baseline,
        SEND_SOURCE,
        "    let minimum_fee = self::native::standard_minimum_fee()\n        .ok_or(Error::SendError(\"standard ZIP-317 fee overflow\".into()))?;\n",
        "    let minimum_fee = 10_000;\n",
        "replace the send-all fee authority with a literal",
      ),
      "standard ZIP-317 fee authority",
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
      "an aliased proposal call cannot be vouched for by an inert string",
      mutated(
        mutated(
          baseline,
          NATIVE_SEND_POLICY_SOURCE,
          "    propose_transfer,",
          "    propose_transfer as routed_proposal,",
          "alias the real proposal import",
        ),
        NATIVE_SEND_POLICY_SOURCE,
        "    propose_transfer::<_, _, _, _, zcash_client_sqlite::wallet::commitment_tree::Error>(",
        "    let _inert_route = \"propose_transfer::<_, _, _, _, zcash_client_sqlite::wallet::commitment_tree::Error>(\";\n    routed_proposal::<_, _, _, _, zcash_client_sqlite::wallet::commitment_tree::Error>(",
        "replace the real proposal call with an alias and inert string",
      ),
      "only direct propose_transfer authority",
    ],
    [
      "a live function-item reference cannot vouch for an aliased proposal call",
      mutated(
        baseline,
        NATIVE_SEND_POLICY_SOURCE,
        "    propose_transfer::<_, _, _, _, zcash_client_sqlite::wallet::commitment_tree::Error>(",
        "    let routed_proposal = propose_transfer::<_, _, _, _, zcash_client_sqlite::wallet::commitment_tree::Error>;\n    routed_proposal(",
        "replace the direct proposal call with a local function-item alias",
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
