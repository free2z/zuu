#!/usr/bin/env node

// Bind KT.md §6.3's repeated-head rule to the one runtime implementation used
// by the log client and witness. The runtime deliberately compares the decoded
// protocol value itself: copying fields into this checker would create the
// second equality definition #892 removes.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DOC = "docs/e2ee/KT.md";
const RUNTIME = "rs/crates/f2z-kt-core/src/sth.rs";
const CLIENT_TEST = "rs/crates/f2z-kt-client/tests/acceptance.rs";
const WITNESS_TEST = "rs/crates/f2z-witness/tests/acceptance.rs";

const ALL_TBS_FIELDS = [
  "label",
  "kt_version",
  "log_id",
  "epoch",
  "tree_size",
  "root_hash",
  "prev_sth_hash",
  "vrf_public_key",
  "published_at_ms",
  "reset_count",
  "epoch_interval_seconds",
  "max_merge_delay_seconds",
  "successor_log_pk",
];

// Constants are rejected before the epoch branch and epoch selects the branch.
// Every other TBS field must have an independent same-epoch fork mutant.
const MUTABLE_TBS_FIELDS = ALL_TBS_FIELDS.slice(4);

const EXPECTED_DOC = `3. Branch on \`epoch\`:
   - If \`epoch < last.epoch\`, the head is a rollback and is fatal.
   - If \`epoch == last.epoch\`, apply rule 8 and stop; rules 4–7 are
     advancement-only.
   - Only if \`epoch > last.epoch\`, continue with rules 4–7.
4. \`tree_size >= last.tree_size\`.
5. \`published_at_ms > last.published_at_ms\`.
6. \`vrf_public_key == last.vrf_public_key\`.
7. **The \`prev_sth_hash\` chain connects.** If \`epoch == last.epoch + 1\`, then
   \`prev_sth_hash == H("free2z/kt/v1/tree-head-hash", tls_codec(last.sth))\` directly.
   If \`epoch > last.epoch + 1\`, the verifier MUST fetch every intervening tree
   head and check the chain link by link. **It MUST NOT skip.** A gap accepted on
   trust is a branch accepted on trust.
8. For \`epoch == last.epoch\`, the complete \`SignedTreeHead\` — every field of
   \`SignedTreeHeadTBS\` and \`signature\` — MUST be identical to the last accepted
   value. An identical re-presentation is an idempotent no-op. Any difference is
   fork evidence and is fatal (§7.3). Equality is over the canonical protocol
   structure; implementations MUST NOT define a second encoding or compare a
   selected field subset.`;

const EXPECTED_RUNTIME = `if head.sth.epoch == self.epoch {
            return if head == &self.last_head {
                Ok(())
            } else {
                Err(KtError::Fork)
            };
        }`;

function marked(source, name) {
  const start = `// ${name}:start`;
  const end = `// ${name}:end`;
  assert.equal(source.split(start).length - 1, 1, `${name}: start marker must occur once`);
  assert.equal(source.split(end).length - 1, 1, `${name}: end marker must occur once`);
  return source.split(start)[1].split(end)[0].trim();
}

function markdownMarked(source, name) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  assert.equal(source.split(start).length - 1, 1, `${name}: start marker must occur once`);
  assert.equal(source.split(end).length - 1, 1, `${name}: end marker must occur once`);
  return source.split(start)[1].split(end)[0].trim();
}

function fieldNames(source) {
  const body = source
    .split("pub struct SignedTreeHeadTBS {")[1]
    ?.split("\n}")[0];
  assert(body, `${RUNTIME}: SignedTreeHeadTBS declaration not found`);
  return [...body.matchAll(/^\s*pub\s+(\w+):/gm)].map((match) => match[1]);
}

function verify(files) {
  const docs = files.get(DOC);
  const runtime = files.get(RUNTIME);
  const client = files.get(CLIENT_TEST);
  const witness = files.get(WITNESS_TEST);
  assert(docs && runtime && client && witness, "required agreement inputs are missing");

  assert.equal(markdownMarked(docs, "kt-sth-repeat-contract"), EXPECTED_DOC, `${DOC}: repeated-head contract drifted`);
  assert.deepEqual(fieldNames(runtime), ALL_TBS_FIELDS, `${RUNTIME}: TBS field inventory drifted; classify and test the new field`);
  assert.match(
    runtime,
    /#\[derive\([^\]]*PartialEq, Eq[^\]]*\)\]\npub struct SignedTreeHead \{/,
    `${RUNTIME}: SignedTreeHead must retain structural equality`,
  );
  assert.equal(marked(runtime, "kt-sth-repeat-runtime"), EXPECTED_RUNTIME, `${RUNTIME}: same-epoch equality must compare the complete canonical value`);
  assert.equal(runtime.split("last_head: SignedTreeHead,").length - 1, 1, `${RUNTIME}: LogView must retain exactly one complete head`);
  assert.equal(runtime.split("last_head: head.clone(),").length - 1, 1, `${RUNTIME}: pin must retain the verified head`);
  assert.equal(runtime.split("self.last_head = head.clone();").length - 1, 1, `${RUNTIME}: advance must retain the newly verified head`);

  const testedFields = [...marked(runtime, "kt-sth-repeat-field-tests").matchAll(/^\s*\("([a-z_]+)"/gm)].map((match) => match[1]);
  assert.deepEqual(testedFields, MUTABLE_TBS_FIELDS, `${RUNTIME}: every mutable TBS field needs an independent same-epoch mutant`);

  assert.match(client, /fn two_handle_lookups_accept_the_same_complete_head_as_a_no_op\(\)/, `${CLIENT_TEST}: same-head multi-handle coverage is missing`);
  assert.match(witness, /Polling again with nothing new is a no-op[\s\S]*Outcome::UpToDate \{ epoch: 3 \}/, `${WITNESS_TEST}: steady repeated-head poll coverage is missing`);
}

function load(root) {
  return new Map([DOC, RUNTIME, CLIENT_TEST, WITNESS_TEST].map((relative) => [
    relative,
    fs.readFileSync(path.join(root, relative), "utf8"),
  ]));
}

function mutated(files, relative, from, to) {
  const copy = new Map(files);
  const source = copy.get(relative);
  assert.equal(source.split(from).length - 1, 1, `self-test target must occur once: ${from}`);
  copy.set(relative, source.replace(from, to));
  return copy;
}

function selfTest(root) {
  const files = load(root);
  verify(files);
  const cases = [
    ["partial spec equality", DOC, "every field of\n   `SignedTreeHeadTBS` and `signature`", "only `root_hash`, `tree_size`, and `published_at_ms`"],
    ["partial runtime equality", RUNTIME, "head == &self.last_head", "head.sth.root_hash == self.root_hash"],
    ["stale retained head", RUNTIME, "self.last_head = head.clone();", "// retained head update deleted"],
    ["missing VRF mutant", RUNTIME, '"vrf_public_key"', '"vrf_key_not_tested"'],
    ["missing multi-handle client proof", CLIENT_TEST, "fn two_handle_lookups_accept_the_same_complete_head_as_a_no_op", "fn deleted_same_head_client_proof"],
    ["missing steady witness proof", WITNESS_TEST, "Polling again with nothing new is a no-op", "Polling coverage deleted"],
  ];
  for (const [name, relative, from, to] of cases) {
    assert.throws(() => verify(mutated(files, relative, from, to)), `${name} mutant survived`);
    console.log(`self-test: ${name}: killed`);
  }
  console.log(`self-test: ${cases.length} KT repeated-head agreement mutants killed`);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--self-test")) {
  console.error("usage: scripts/check-kt-sth-repeat-agreement.mjs [--self-test]");
  process.exit(2);
}

try {
  if (args[0] === "--self-test") selfTest(repoRoot);
  else {
    verify(load(repoRoot));
    console.log("KT repeated-head spec/runtime agreement is complete.");
  }
} catch (error) {
  console.error(`KT repeated-head agreement check failed: ${error.message}`);
  process.exit(1);
}
