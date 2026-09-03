#!/usr/bin/env node

// One bounded proof-of-work policy across the public contract and shipping
// Rust. This source check is deliberately independent of the Rust tests: a
// coordinated edit that changes both runtime constants and their unit-test
// expectations must still fail until the public policy is reviewed too.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const paths = {
  wire: "docs/e2ee/WIRE.md",
  contract: "docs/e2ee/CLIENT-CONTRACT.md",
  decision: "docs/e2ee/decisions/0011-first-contact-contact-queues.md",
  codec: "rs/crates/f2z-codec/src/pow.rs",
  proto: "rs/crates/f2z-relay-proto/src/capabilities.rs",
  config: "rs/crates/f2z-relay/src/config.rs",
  relay: "wallet/plugins/tauri-plugin-f2zmsg/src/relay.rs",
  ui: "wallet/zuuli/src/features/messages/FirstContact.tsx",
};

function liveSources() {
  return Object.fromEntries(
    Object.entries(paths).map(([name, relative]) => [
      name,
      fs.readFileSync(path.join(root, relative), "utf8"),
    ]),
  );
}

function required(source, needle, label, failures) {
  if (!source.includes(needle)) failures.push(`${label}: missing ${JSON.stringify(needle)}`);
}

export function powPolicyFailures(sources) {
  const failures = [];
  const { wire, contract, decision, codec, proto, config, relay, ui } = sources;

  for (const [needle, label] of [
    ["pub const DEFAULT_POW_DIFFICULTY_BITS: u8 = 20;", "codec default difficulty"],
    ["pub const MAX_POW_DIFFICULTY_BITS: u8 = DEFAULT_POW_DIFFICULTY_BITS;", "codec difficulty ceiling"],
    ["pub const DEFAULT_POW_CHALLENGE_TTL_MS: u32 = 60_000;", "codec default challenge lifetime"],
    ["pub const MAX_POW_CHALLENGE_TTL_MS: u32 = DEFAULT_POW_CHALLENGE_TTL_MS;", "codec challenge-lifetime ceiling"],
    ["pub const MAX_POW_ATTEMPTS: u64 = 1 << 24;", "codec candidate budget"],
    ["pub const MAX_POW_SOLVE_MS: u64 = 30_000;", "codec wall-clock budget"],
    ["self.difficulty_bits > MAX_POW_DIFFICULTY_BITS", "codec validates difficulty ceiling"],
    ["self.challenge_ttl_ms > MAX_POW_CHALLENGE_TTL_MS", "codec validates lifetime ceiling"],
  ]) required(codec, needle, label, failures);

  for (const [needle, label] of [
    ["`difficulty_bits` in 1..=20", "WIRE signed-capability difficulty range"],
    ["challenge_ttl_ms` in\n   1..=60000", "WIRE signed-capability lifetime range"],
    ["16,777,216", "WIRE candidate budget"],
    ["30,000 ms", "WIRE wall-clock budget"],
    ["MUST NOT wrap to zero", "WIRE counter exhaustion"],
    ["cooperatively", "WIRE cancellation"],
    ["not a benchmark\nresult", "WIRE provisional default"],
    ["before requesting a\nchallenge or beginning a search", "WIRE pre-work refusal"],
  ]) required(wire, needle, label, failures);

  for (const [needle, label] of [
    ["reject signed work\n  above 20 bits before starting", "client pre-work refusal"],
    ["16,777,216-candidate, 30,000 ms", "client finite work policy"],
    ["No supported-phone duration has been measured", "client calibration honesty"],
    ["never continue or wrap an exhausted search", "client failure behavior"],
    ["algorithm 1 / 20-bit / 60000 ms default", "client provisional tuple"],
  ]) required(contract, needle, label, failures);

  required(
    decision,
    "not evidence of a supported-phone duration or an attacker cost",
    "ADR calibration honesty",
    failures,
  );

  for (const [needle, label] of [
    ["difficulty_bits > MAX_POW_DIFFICULTY_BITS", "protocol signed difficulty refusal"],
    ["challenge_ttl_ms > MAX_POW_CHALLENGE_TTL_MS", "protocol signed lifetime refusal"],
    ["Refusal::PowWorkPolicyExceeded", "protocol named work-policy refusal"],
    ["difficulty_bits: DEFAULT_POW_DIFFICULTY_BITS", "protocol shared default difficulty"],
    ["challenge_ttl_ms: DEFAULT_POW_CHALLENGE_TTL_MS", "protocol shared default lifetime"],
  ]) required(proto, needle, label, failures);

  for (const [needle, label] of [
    ["queue_creation_pow_bits: f2z_codec::pow::DEFAULT_POW_DIFFICULTY_BITS", "relay shared queue default"],
    ["contact_append_pow_bits: f2z_codec::pow::DEFAULT_POW_DIFFICULTY_BITS", "relay shared contact default"],
    ["claim_key_package_pow_bits: f2z_codec::pow::DEFAULT_POW_DIFFICULTY_BITS", "relay shared claim default"],
    ["challenge_ttl_ms: f2z_codec::pow::DEFAULT_POW_CHALLENGE_TTL_MS", "relay shared lifetime default"],
    ["difficulty > f2z_codec::pow::MAX_POW_DIFFICULTY_BITS", "relay configuration difficulty ceiling"],
    ["challenge_ttl_ms > f2z_codec::pow::MAX_POW_CHALLENGE_TTL_MS", "relay configuration lifetime ceiling"],
  ]) required(config, needle, label, failures);
  if (config.includes("pow_bits > 64")) failures.push("relay retains the divergent 64-bit ceiling");

  for (const [needle, label] of [
    ["tokio::task::spawn_blocking", "shipping solver leaves async executor"],
    ["tokio::time::timeout(valid_for, worker)", "shipping solver deadline"],
    ["struct CancelPowOnDrop", "shipping caller cancellation"],
    ["MAX_POW_ATTEMPTS", "shipping candidate budget"],
    ["checked_add(1)", "shipping checked counter"],
    ["PowSolveError::CounterExhausted", "shipping counter-exhaustion result"],
    ["cancelled.load(Ordering::Acquire)", "shipping cooperative cancellation poll"],
    ["self.policy.accept(&signed.capabilities)", "shipping signed policy acceptance"],
    ["capabilities::check_digest", "shipping HELLO digest binding"],
    ["if issued.pow != params", "shipping challenge/capability agreement"],
  ]) required(relay, needle, label, failures);
  if (relay.includes("wrapping_add(1)")) failures.push("shipping solver can wrap its counter");

  for (const unsupported of ["can take several seconds", "This can take several"]) {
    if (ui.includes(unsupported)) failures.push(`shipping UI retains unsupported timing claim ${JSON.stringify(unsupported)}`);
  }

  return failures;
}

function checkLive() {
  const failures = powPolicyFailures(liveSources());
  if (failures.length) throw new Error(`bounded PoW policy drift:\n- ${failures.join("\n- ")}`);
  console.log("bounded PoW spec/runtime policy: passed");
}

function selfTest() {
  const original = liveSources();
  const mutations = [
    ["codec maximum", "codec", "MAX_POW_DIFFICULTY_BITS: u8 = DEFAULT_POW_DIFFICULTY_BITS", "MAX_POW_DIFFICULTY_BITS: u8 = 21"],
    ["WIRE maximum", "wire", "`difficulty_bits` in 1..=20", "`difficulty_bits` in 1..=21"],
    ["client candidate budget", "contract", "16,777,216-candidate", "unbounded-candidate"],
    ["relay shared default", "config", "queue_creation_pow_bits: f2z_codec::pow::DEFAULT_POW_DIFFICULTY_BITS", "queue_creation_pow_bits: 20"],
    ["signed policy check", "proto", "difficulty_bits > MAX_POW_DIFFICULTY_BITS", "difficulty_bits < MAX_POW_DIFFICULTY_BITS"],
    ["blocking isolation", "relay", "tokio::task::spawn_blocking", "tokio::spawn"],
    ["counter wrap", "relay", "checked_add(1)", "wrapping_add(1)"],
    ["caller cancellation", "relay", "struct CancelPowOnDrop", "struct IgnorePowOnDrop"],
    ["unsupported UI timing", "ui", "Duration varies by device.", "This can take several seconds."],
  ];

  for (const [name, key, needle, replacement] of mutations) {
    const changed = original[key].replace(needle, replacement);
    assert.notEqual(changed, original[key], `${name}: mutation did not apply`);
    assert.notDeepEqual(
      powPolicyFailures({ ...original, [key]: changed }),
      [],
      `${name}: mutation escaped`,
    );
    console.log(`self-test: ${name}: passed`);
  }
}

const mode = process.argv[2];
if (mode === "--self-test") selfTest();
else if (mode === undefined) checkLive();
else {
  console.error("usage: scripts/check-pow-policy.mjs [--self-test]");
  process.exitCode = 2;
}
