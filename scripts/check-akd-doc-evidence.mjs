#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = join(repoRoot, "docs/e2ee/evidence");
const benchmarkPath = join(evidenceRoot, "akd-benchmark.json");
const auditPath = join(evidenceRoot, "akd-audit-scope.json");
const apiPath = join(repoRoot, "rs/crates/f2z-kt/tests/akd_doc_api.rs");

// These anchors are deliberately independent of the JSON and Markdown under
// test. Updating presentation and its artifact together must not redefine the
// reviewed evidence. Each value below is also checked against its remote,
// immutable source before it is allowed to vouch for the local files.
const benchmarkAnchor = Object.freeze({
  apiUrl: "https://api.github.com/repos/free2z/zuu/issues/comments/5389135744",
  id: 5389135744,
  nodeId: "IC_kwDOG6Qgsc8AAAABQTevgA",
  createdAt: "2026-08-23T23:42:17Z",
  updatedAt: "2026-08-23T23:42:17Z",
  bodySha256: "51aaaf4360bce1b3f92839ef13e1bffd96bcbaa62d6bf662383ef6cdc980e2db",
});

const reportAnchor = Object.freeze({
  publisher: "NCC Group Cryptography Services",
  url: "https://www.nccgroup.com/media/phzpm0qv/_ncc_group_metaplatforms_e008327_report_2023-11-14_v10.pdf",
  sha256: "42f793909b900eb2e6eefb1825284bd92f90849dd9de8ec6a71ac2199030073e",
  finding: "NCC-E008327-Q3U",
  reportPages: "4-5",
  figure: "Figure 2: recursive_batch_insert_nodes() in akd/src/append_only_zks.rs",
});

const releaseAnchors = Object.freeze({
  repository: "https://github.com/facebook/akd",
  path: "akd/src/append_only_zks.rs",
  audited: Object.freeze({
    release: "v0.9.0",
    commit: "be1055ee8a2b5291d84206592d8f46b7f042bbe1",
    gitBlobSha1: "aabc19e75d3eca08d2d70ebdf9fb00a356b195ce",
    rawSha256: "da233bd03845252627614dff21caa887262ca72a58b33012ae7a1fdb6aa1f83a",
  }),
  selected: Object.freeze({
    release: "v0.13.0",
    commit: "43a60ccf7dfdd8f4b628186410e871192adaf65b",
    gitBlobSha1: "3b5009321c8d6bba3ff5da24e73851e26b622144",
    rawSha256: "bca38d27748aa19969d8f4ccae77d793ecb0557649ee1f0754f850e50db61e85",
  }),
  partitionSignature:
    "pub(crate) fn partition(self, prefix_label: NodeLabel) -> (AzksElementSet, AzksElementSet)",
  partitionBodySha256: "d86b7a60e9d95699256f11ff1a003885fd68dc0989f8906442953f5f708658a1",
});

const fixAnchors = Object.freeze({
  q3u_publish_only: Object.freeze({
    apiUrl: "https://api.github.com/repos/facebook/akd/pulls/400",
    url: "https://github.com/facebook/akd/pull/400",
    patchUrl: "https://github.com/facebook/akd/pull/400.patch",
    patchSha256: "c507b382007954a243fc467a92a457df69ebacdcef5cfe27f1dcd9e3b8e1a891",
    id: 1499550422,
    nodeId: "PR_kwDOFr0TCM5ZYVLW",
    number: 400,
    title: "Adding duplicate entries check in publish",
    author: "kevinlewi",
    mergedAt: "2023-09-21T18:17:47Z",
    headCommit: "cd4fd180cd2774dba64dc2ec5ec46890f985a163",
    mergeCommit: "b9e97b49a514e24736fbe91f825f40cb8a36ca3f",
    changedFiles: 3,
    requiredPatchText: Object.freeze([
      "Subject: [PATCH] Adding duplicate entries check in publish",
      "updates.iter().map(|(label, _)| label.clone()).collect();",
      "if distinct_set.len() != updates.len()",
      "DirectoryError::Publish",
      "test_publish_duplicate_entries",
    ]),
    forbiddenPatchText: "InsertMode::Auditor",
  }),
  auditor_residual: Object.freeze({
    apiUrl: "https://api.github.com/repos/facebook/akd/pulls/495",
    url: "https://github.com/facebook/akd/pull/495",
    patchUrl: "https://github.com/facebook/akd/pull/495.patch",
    patchSha256: "ff1387d4a349e840ffe2cd8d1ee39d59b11009097f2d7526e0b30a2d86a4f3a6",
    id: 4258069338,
    nodeId: "PR_kwDOFr0TCM79zPta",
    number: 495,
    title: "Fix auditor append-only bypass in batch node insertion",
    author: "kevinlewi",
    mergedAt: "2026-08-12T17:45:01Z",
    headCommit: "685e2a77e253fe49fad1ea191e75b5482f677e38",
    mergeCommit: "2e99b036d6d2435775ec4e10cf560d01f341ec01",
    changedFiles: 3,
    requiredPatchText: Object.freeze([
      "Subject: [PATCH] Fix auditor append-only bypass in batch node insertion",
      "if matches!(insert_mode, InsertMode::Auditor)",
      "left_azks_element_set.len() + right_azks_element_set.len() != element_count",
      "BatchInsertDroppedNode",
      "test_auditor_rejects_prefix_collision_value_rewrite",
    ]),
    forbiddenPatchText: "pub async fn publish",
  }),
});

const metricInventory = new Map([
  ["verifier_size_raw", 1],
  ["verifier_size_gzip", 1],
  ["verifier_size_brotli", 1],
  ["verifier_recommended_raw", 2],
  ["verifier_recommended_brotli", 3],
]);

const claimInventory = new Map([
  ["audit_scope", "docs/e2ee/decisions/0013-key-transparency-log.md"],
  ["history_proof_type", "docs/e2ee/KT.md"],
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitBlobSha1(value) {
  return createHash("sha1")
    .update(`blob ${value.length}\0`)
    .update(value)
    .digest("hex");
}

function bytes(value) {
  return `${value.toLocaleString("en-US")} B`;
}

function metricValues(benchmark) {
  const size = benchmark.verifier_bundles.size_optimized;
  const recommended = benchmark.verifier_bundles.recommended;
  return new Map([
    ["verifier_size_raw", bytes(size.raw_bytes)],
    ["verifier_size_gzip", bytes(size.gzip_9_bytes)],
    ["verifier_size_brotli", bytes(size.brotli_q11_bytes)],
    ["verifier_recommended_raw", bytes(recommended.raw_bytes)],
    ["verifier_recommended_brotli", bytes(recommended.brotli_q11_bytes)],
  ]);
}

function validateBenchmark(benchmark) {
  assert.equal(benchmark.schema, 1, "unsupported benchmark evidence schema");
  assert.equal(benchmark.provenance.akd_core, "0.13.0");
  for (const profile of Object.values(benchmark.verifier_bundles)) {
    for (const field of ["raw_bytes", "gzip_9_bytes", "brotli_q11_bytes"]) {
      assert(Number.isSafeInteger(profile[field]) && profile[field] > 0, `${field} must be a positive integer`);
    }
  }
}

function benchmarkValuesFromComment(comment) {
  assert.equal(comment.id, benchmarkAnchor.id, "benchmark comment id changed");
  assert.equal(comment.node_id, benchmarkAnchor.nodeId, "benchmark comment node id changed");
  assert.equal(comment.created_at, benchmarkAnchor.createdAt, "benchmark comment creation time changed");
  assert.equal(comment.updated_at, benchmarkAnchor.updatedAt, "benchmark comment update time changed");
  assert.equal(sha256(comment.body), benchmarkAnchor.bodySha256, "benchmark comment body changed");
  const parseRow = (profile) => {
    const escaped = profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(
      `^\\| Verifier, \`${escaped}\` \\| ([0-9,]+) B[^|]*\\| ([0-9,]+) B[^|]*\\| (?:\\*\\*)?([0-9,]+) B`,
      "m",
    ).exec(comment.body);
    assert(match, `immutable benchmark comment lacks the ${profile} verifier row`);
    return {
      raw_bytes: Number(match[1].replaceAll(",", "")),
      gzip_9_bytes: Number(match[2].replaceAll(",", "")),
      brotli_q11_bytes: Number(match[3].replaceAll(",", "")),
    };
  };
  return {
    size_optimized: parseRow('opt-level="z"'),
    recommended: parseRow("opt-level=3"),
  };
}

function validateBenchmarkAnchor(benchmark, comment) {
  assert.equal(
    benchmark.provenance.issue,
    "https://github.com/free2z/zuu/issues/544#issuecomment-5389135744",
  );
  const anchored = benchmarkValuesFromComment(comment);
  for (const profile of Object.keys(anchored)) {
    assert.deepEqual(
      benchmark.verifier_bundles[profile],
      { ...benchmark.verifier_bundles[profile], ...anchored[profile] },
      `${profile} benchmark figures differ from immutable issue-comment evidence`,
    );
  }
}

function validateMetricClaims(files, benchmark) {
  const expectedValues = metricValues(benchmark);
  const counts = new Map([...metricInventory.keys()].map((key) => [key, 0]));
  const markerPattern = /\*\*([^*]+)\*\*<!-- akd-metric:([a-z0-9_]+) -->/g;

  for (const [relativePath, source] of files) {
    for (const match of source.matchAll(markerPattern)) {
      const [, displayed, key] = match;
      assert(expectedValues.has(key), `${relativePath}: unknown AKD metric marker ${key}`);
      assert.equal(displayed, expectedValues.get(key), `${relativePath}: ${key} drifted from benchmark evidence`);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  for (const [key, expectedCount] of metricInventory) {
    assert.equal(counts.get(key), expectedCount, `${key} must have exactly ${expectedCount} bound documentation occurrence(s)`);
  }
}

function claimBlock(source, key) {
  const start = `<!-- akd-claim:${key}:start -->`;
  const end = `<!-- akd-claim:${key}:end -->`;
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end);
  assert(startIndex >= 0 && endIndex > startIndex, `missing complete ${key} claim block`);
  assert.equal(source.indexOf(start, startIndex + 1), -1, `duplicate ${key} claim start`);
  assert.equal(source.indexOf(end, endIndex + 1), -1, `duplicate ${key} claim end`);
  return source
    .slice(startIndex + start.length, endIndex)
    .trim()
    .split("\n")
    .map((line) => line.trimStart())
    .join("\n");
}

function replaceClaimBlock(source, key, replacement) {
  const start = `<!-- akd-claim:${key}:start -->`;
  const end = `<!-- akd-claim:${key}:end -->`;
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert(startIndex >= 0 && endIndex > startIndex, `cannot replace incomplete ${key} claim block`);
  return `${source.slice(0, startIndex + start.length)}\n${replacement}\n${source.slice(endIndex)}`;
}

function expectedAuditClaim(audit) {
  const { audited, selected } = audit.upstream;
  return [
    `**Correction (2026-08-24) — NCC reviewed the affected insertion path.** Finding`,
    `[${audit.report.finding}](${audit.report.url}) (report pages ${audit.report.report_pages}) walks through`,
    `\`recursive_batch_insert_nodes()\` and reproduces it as ${audit.report.figure}.`,
    `The complete \`partition()\` body is byte-for-byte identical between audited`,
    `[${audited.release}](${audit.upstream.repository}/tree/${audited.commit}) and selected`,
    `[${selected.release}](${audit.upstream.repository}/tree/${selected.commit}); the pinned source-object and body`,
    `hashes are verified by \`scripts/check-akd-doc-evidence.mjs\`. Q3U's fix in`,
    `[#400](${audit.fixes.q3u_publish_only.url}) rejected duplicate labels in \`publish()\`, but did not guard the`,
    `\`InsertMode::Auditor\` insertion used by append-only verification. That residual gap survived until`,
    `[#495](${audit.fixes.auditor_residual.url}) in 0.13.0. The lesson is therefore stronger and narrower: a paid review`,
    `examined the same insertion and silent-drop bug class, yet its publish-only remediation left the auditor`,
    `variant exploitable for almost three years. The auditor path remains our highest-value review and fuzz target.`,
  ].join("\n");
}

function expectedHistoryClaim() {
  return "| `POST` | `/kt/v1/history` | `{handle, params}` → `DirectoryEntry<>` + `HistoryProof` + tree head + cosignatures | anyone |";
}

function validateClaimBlocks(files, audit) {
  const byPath = new Map(files);
  for (const [key, relativePath] of claimInventory) {
    assert(byPath.has(relativePath), `missing documentation file ${relativePath}`);
    const source = byPath.get(relativePath);
    if (key === "history_proof_type") {
      const expected = expectedHistoryClaim();
      assert.equal(source.split(expected).length - 1, 1, `${relativePath}: normative HistoryProof row must occur exactly once`);
      assert(!source.includes("HistoryProofV2"), `${relativePath}: invented HistoryProofV2 type remains normative`);
    } else {
      assert.equal(claimBlock(source, key), expectedAuditClaim(audit), `${relativePath}: ${key} claim drifted from executable evidence`);
    }
  }
}

function extractRustFunction(source, signature) {
  const signatureIndex = source.indexOf(signature);
  assert(signatureIndex >= 0, `pinned source lacks ${signature}`);
  assert.equal(source.indexOf(signature, signatureIndex + 1), -1, `pinned source duplicates ${signature}`);
  const open = source.indexOf("{", signatureIndex + signature.length);
  assert(open >= 0, `pinned source lacks body for ${signature}`);

  let depth = 0;
  let mode = "code";
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (mode === "line-comment") {
      if (char === "\n") mode = "code";
      continue;
    }
    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        mode = "code";
        index += 1;
      }
      continue;
    }
    if (mode === "string" || mode === "character") {
      if (char === "\\") {
        index += 1;
      } else if ((mode === "string" && char === '"') || (mode === "character" && char === "'")) {
        mode = "code";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      mode = "line-comment";
      index += 1;
    } else if (char === "/" && next === "*") {
      mode = "block-comment";
      index += 1;
    } else if (char === '"') {
      mode = "string";
    } else if (char === "'") {
      mode = "character";
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(signatureIndex, index + 1).replaceAll("\r\n", "\n").trim();
    }
  }
  assert.fail(`unterminated body for ${signature}`);
}

class EvidenceTransportError extends Error {
  constructor(url, detail) {
    super(`pinned evidence unavailable ${url}: ${detail}`);
    this.name = "EvidenceTransportError";
  }
}

function evidenceHeaders(url, accept, token) {
  const headers = { "User-Agent": "free2z-zuu-akd-evidence-check" };
  if (accept) headers.Accept = accept;
  if (token && new URL(url).origin === "https://api.github.com") {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function isTransientResponse(response) {
  return response.status === 429 ||
    response.status >= 500 && response.status <= 599 ||
    response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds);

async function fetchPinnedValue(url, {
  accept,
  attempts = 3,
  consume,
  fetchImpl = fetch,
  signalForTimeout = timeoutSignal,
  sleep = delay,
  token = process.env.GITHUB_TOKEN,
} = {}) {
  let lastFailure;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: evidenceHeaders(url, accept, token),
        signal: signalForTimeout(30_000),
      });
      if (response.ok) {
        return await consume(response);
      } else {
        lastFailure = `HTTP ${response.status}`;
        if (!isTransientResponse(response) || attempt === attempts) {
          throw new EvidenceTransportError(url, lastFailure);
        }
      }
    } catch (error) {
      if (error instanceof EvidenceTransportError) throw error;
      lastFailure = error instanceof Error ? error.message : String(error);
      if (attempt === attempts) {
        throw new EvidenceTransportError(url, lastFailure);
      }
    }
    await sleep(attempt * 250);
  }
  throw new EvidenceTransportError(url, lastFailure ?? "request failed");
}

async function fetchPinnedBytes(url, options) {
  return fetchPinnedValue(url, {
    ...options,
    consume: async (response) => Buffer.from(await response.arrayBuffer()),
  });
}

async function fetchPinnedJson(url, options = {}) {
  return fetchPinnedValue(url, {
    ...options,
    accept: "application/vnd.github+json",
    consume: (response) => response.json(),
  });
}

function validateReportRecord(audit) {
  assert.deepEqual(audit.report, {
    publisher: reportAnchor.publisher,
    url: reportAnchor.url,
    sha256: reportAnchor.sha256,
    finding: reportAnchor.finding,
    report_pages: reportAnchor.reportPages,
    figure: reportAnchor.figure,
  }, "NCC report record differs from independently reviewed anchors");
}

function validateReleaseRecords(audit) {
  assert.equal(audit.upstream.repository, releaseAnchors.repository);
  assert.equal(audit.upstream.path, releaseAnchors.path);
  for (const name of ["audited", "selected"]) {
    const anchor = releaseAnchors[name];
    assert.deepEqual(
      audit.upstream[name],
      {
        release: anchor.release,
        commit: anchor.commit,
        git_blob_sha1: anchor.gitBlobSha1,
        raw_sha256: anchor.rawSha256,
      },
      `${name} release record differs from independently reviewed anchors`,
    );
  }
  assert.equal(audit.upstream.partition_signature, releaseAnchors.partitionSignature);
  assert.equal(audit.upstream.partition_body_sha256, releaseAnchors.partitionBodySha256);
  assert.notEqual(audit.upstream.audited.release, audit.upstream.selected.release);
  assert.notEqual(audit.upstream.audited.commit, audit.upstream.selected.commit);
  assert.notEqual(audit.upstream.audited.raw_sha256, audit.upstream.selected.raw_sha256);
}

function fixRecord(anchor) {
  return {
    url: anchor.url,
    number: anchor.number,
    node_id: anchor.nodeId,
    head_commit: anchor.headCommit,
    merge_commit: anchor.mergeCommit,
    patch_sha256: anchor.patchSha256,
  };
}

function validateFixRecords(audit) {
  for (const [name, anchor] of Object.entries(fixAnchors)) {
    assert.deepEqual(
      audit.fixes[name],
      fixRecord(anchor),
      `${name} fix record differs from independently reviewed PR anchors`,
    );
  }
}

function validatePullRequestIdentity(pull, anchor) {
  assert.equal(pull.id, anchor.id, `PR #${anchor.number} database id changed`);
  assert.equal(pull.node_id, anchor.nodeId, `PR #${anchor.number} node id changed`);
  assert.equal(pull.number, anchor.number, `PR #${anchor.number} number changed`);
  assert.equal(pull.html_url, anchor.url, `PR #${anchor.number} canonical URL changed`);
  assert.equal(pull.title, anchor.title, `PR #${anchor.number} title changed`);
  assert.equal(pull.user?.login, anchor.author, `PR #${anchor.number} author changed`);
  assert.equal(pull.merged_at, anchor.mergedAt, `PR #${anchor.number} merge time changed`);
  assert.equal(pull.head?.sha, anchor.headCommit, `PR #${anchor.number} head commit changed`);
  assert.equal(pull.merge_commit_sha, anchor.mergeCommit, `PR #${anchor.number} merge commit changed`);
  assert.equal(pull.changed_files, anchor.changedFiles, `PR #${anchor.number} changed-file count changed`);
}

function validateFixPatch(patch, anchor) {
  assert.equal(sha256(patch), anchor.patchSha256, `PR #${anchor.number} patch bytes changed`);
  const source = patch.toString("utf8");
  for (const text of anchor.requiredPatchText) {
    assert(source.includes(text), `PR #${anchor.number} patch lacks reviewed semantic: ${text}`);
  }
  assert(
    !source.includes(anchor.forbiddenPatchText),
    `PR #${anchor.number} is not scoped as claimed: found ${anchor.forbiddenPatchText}`,
  );
}

async function validateFixEvidence(audit) {
  validateFixRecords(audit);
  const evidence = {};
  for (const [name, anchor] of Object.entries(fixAnchors)) {
    const [pull, patch] = await Promise.all([
      fetchPinnedJson(anchor.apiUrl),
      fetchPinnedBytes(anchor.patchUrl),
    ]);
    validatePullRequestIdentity(pull, anchor);
    validateFixPatch(patch, anchor);
    evidence[name] = { patch, pull };
  }
  return evidence;
}

function countToken(source, token) {
  return source.split(token).length - 1;
}

// This deliberately reads only stable, uncompressed PDF structure. The full
// file hash fixes every compressed content stream; the outline, destination,
// page/content linkage and audited-source annotations independently establish
// which finding those bytes describe without depending on poppler or any other
// executable absent from the required Ubuntu job.
function validateReportSemantics(report) {
  const source = report.toString("latin1");
  const structuralClaims = new Map([
    ["%PDF-1.7", 1],
    ["/Keywords (NCC Group report, E008327,", 1],
    ["/Title (Multiple Key Updates During Epoch Results in Invalid State)/Dest [117 0 R", 1],
    ["/Contents 116 0 R", 1],
    ["/Contents 118 0 R", 1],
    ["(finding:Q3U)", 7],
    ["https://github.com/facebook/akd/blob/v0.9.0/akd/src/append_only_zks.rs#L396-#L405", 2],
  ]);
  for (const [claim, expectedCount] of structuralClaims) {
    assert.equal(
      countToken(source, claim),
      expectedCount,
      `NCC report structure does not uniquely establish ${claim}`,
    );
  }
  return source;
}

function validateTagRefs(output) {
  const refs = new Map(
    output.trim().split("\n").filter(Boolean).map((line) => {
      const [commit, ref] = line.split(/\s+/);
      return [ref, commit];
    }),
  );
  assert.equal(refs.get(`refs/tags/${releaseAnchors.audited.release}`), releaseAnchors.audited.commit);
  assert.equal(refs.get(`refs/tags/${releaseAnchors.selected.release}`), releaseAnchors.selected.commit);
  assert.notEqual(
    refs.get(`refs/tags/${releaseAnchors.audited.release}`),
    refs.get(`refs/tags/${releaseAnchors.selected.release}`),
  );
}

function fetchTagRefs() {
  const result = spawnSync("git", [
    "ls-remote",
    releaseAnchors.repository,
    `refs/tags/${releaseAnchors.audited.release}`,
    `refs/tags/${releaseAnchors.selected.release}`,
  ], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `unable to resolve immutable AKD release tags: ${result.stderr}`);
  validateTagRefs(result.stdout);
}

function validatePinnedSource(content, entry, signature, expectedBodyHash) {
  assert.equal(sha256(content), entry.raw_sha256, `${entry.release} raw source hash changed`);
  assert.equal(gitBlobSha1(content), entry.git_blob_sha1, `${entry.release} git blob hash changed`);
  const body = extractRustFunction(content.toString("utf8"), signature);
  assert.equal(sha256(body), expectedBodyHash, `${entry.release} partition body changed`);
  return body;
}

function validatePartitionEquality(bodies) {
  assert.equal(bodies.length, 2, "audit scope comparison requires exactly two pinned releases");
  assert.equal(bodies[0], bodies[1], "partition() differs between audited v0.9.0 and selected v0.13.0");
}

function validateDistinctVersionSources(sources) {
  assert.equal(sources.length, 2, "audit scope requires exactly two source versions");
  assert.notDeepEqual(sources[0], sources[1], "audit scope aliases one source body as two releases");
}

async function validateAuditEvidence(audit) {
  assert.equal(audit.schema, 1, "unsupported audit evidence schema");
  validateReportRecord(audit);
  validateReleaseRecords(audit);
  const fixEvidence = await validateFixEvidence(audit);
  fetchTagRefs();
  const report = await fetchPinnedBytes(reportAnchor.url);
  assert.equal(sha256(report), reportAnchor.sha256, "NCC report bytes changed from the reviewed artifact");
  const reportStructure = validateReportSemantics(report);

  const bodies = [];
  const sources = [];
  for (const entry of [audit.upstream.audited, audit.upstream.selected]) {
    const url = `https://raw.githubusercontent.com/facebook/akd/${entry.commit}/${audit.upstream.path}`;
    const source = await fetchPinnedBytes(url);
    sources.push(source);
    bodies.push(validatePinnedSource(source, entry, audit.upstream.partition_signature, audit.upstream.partition_body_sha256));
  }
  validateDistinctVersionSources(sources);
  validatePartitionEquality(bodies);
  return { bodies, fixEvidence, report, reportStructure, sources };
}

async function cargoCommand() {
  const pin = /channel\s*=\s*"([^"]+)"/.exec(
    await readFile(join(repoRoot, "wallet/rust-toolchain.toml"), "utf8"),
  )?.[1];
  assert(pin, "unable to read the repository Rust toolchain pin");
  return { command: "cargo", args: [`+${pin}`] };
}

async function compileApiFixture(source, expectSuccess) {
  let workspace = join(repoRoot, "rs");
  if (!expectSuccess) {
    const fixture = await mkdtemp(join(tmpdir(), "zuu-akd-api-evidence-"));
    workspace = join(fixture, "rs");
    const sourceWorkspace = join(repoRoot, "rs");
    await cp(sourceWorkspace, workspace, {
      recursive: true,
      filter: (sourcePath) =>
        !sourcePath
          .slice(sourceWorkspace.length)
          .split(/[\\/]/)
          .includes("target"),
    });
    await writeFile(join(workspace, "crates/f2z-kt/tests/akd_doc_api.rs"), source);
  }
  const lock = await readFile(join(workspace, "Cargo.lock"), "utf8");
  assert.match(
    lock,
    /\[\[package\]\]\nname = "akd"\nversion = "0\.13\.0"\n/,
    "rs/Cargo.lock must pin AKD 0.13.0",
  );
  const cargo = await cargoCommand();
  const result = spawnSync(
    cargo.command,
    [
      ...cargo.args,
      "test",
      "--locked",
      "-p",
      "f2z-kt",
      "--test",
      "akd_doc_api",
      "--no-run",
      "--quiet",
    ],
    {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        CARGO_TARGET_DIR: join(repoRoot, "rs/target/akd-doc-evidence"),
      },
      timeout: 180_000,
    },
  );
  if (expectSuccess && result.status !== 0) {
    throw new Error(`AKD 0.13 API fixture did not compile:\n${result.stderr}`);
  }
  if (!expectSuccess && result.status === 0) {
    throw new Error("HistoryProofV2 compile mutant unexpectedly survived");
  }
  return result;
}

async function documentationFiles() {
  const paths = [
    "docs/e2ee/KT.md",
    "docs/e2ee/decisions/0013-key-transparency-log.md",
  ];
  return Promise.all(paths.map(async (relativePath) => [relativePath, await readFile(join(repoRoot, relativePath), "utf8")]));
}

async function live() {
  const benchmark = JSON.parse(await readFile(benchmarkPath, "utf8"));
  const audit = JSON.parse(await readFile(auditPath, "utf8"));
  const files = await documentationFiles();
  validateBenchmark(benchmark);
  validateBenchmarkAnchor(benchmark, await fetchPinnedJson(benchmarkAnchor.apiUrl));
  validateMetricClaims(files, benchmark);
  validateClaimBlocks(files, audit);
  await validateAuditEvidence(audit);
  await compileApiFixture(await readFile(apiPath, "utf8"), true);
  process.stdout.write("AKD documentation evidence verified\n");
}

async function selfTest() {
  const benchmark = JSON.parse(await readFile(benchmarkPath, "utf8"));
  const audit = JSON.parse(await readFile(auditPath, "utf8"));
  const files = await documentationFiles();
  validateBenchmark(benchmark);
  const benchmarkComment = await fetchPinnedJson(benchmarkAnchor.apiUrl);
  validateBenchmarkAnchor(benchmark, benchmarkComment);
  validateMetricClaims(files, benchmark);
  validateClaimBlocks(files, audit);
  const killed = {
    displayedMetrics: 0,
    benchmarkArtifacts: 0,
    coordinatedEvidence: 0,
    claims: 0,
    pinnedSource: 0,
    compileApi: 0,
    transportGuards: 0,
  };

  const inertSignal = AbortSignal.abort("self-test");
  const savedToken = process.env.GITHUB_TOKEN;
  let apiRequest;
  const apiTimeouts = [];
  process.env.GITHUB_TOKEN = "test-token";
  try {
    const apiResult = await fetchPinnedJson(benchmarkAnchor.apiUrl, {
      fetchImpl: async (url, options) => {
        apiRequest = { options, url };
        return new Response('{"anchored":true}', { status: 200 });
      },
      signalForTimeout: (milliseconds) => {
        apiTimeouts.push(milliseconds);
        return inertSignal;
      },
      sleep: async () => assert.fail("successful API request slept"),
    });
    assert.deepEqual(apiResult, { anchored: true }, "real JSON consumer was not exercised");
  } finally {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  }
  assert.equal(apiRequest?.url, benchmarkAnchor.apiUrl, "real API request URL changed");
  assert.equal(apiRequest?.options.headers.Authorization, "Bearer test-token", "real API request lost its token");
  assert.equal(apiRequest?.options.headers.Accept, "application/vnd.github+json", "real JSON request lost its media type");
  assert.equal(apiRequest?.options.signal, inertSignal, "real API request lost its timeout signal");
  assert.deepEqual(apiTimeouts, [30_000], "real API request timeout changed");
  killed.transportGuards += 5;

  let unauthenticatedApiRequest;
  await fetchPinnedJson(benchmarkAnchor.apiUrl, {
    fetchImpl: async (_url, options) => {
      unauthenticatedApiRequest = options;
      return new Response("{}", { status: 200 });
    },
    signalForTimeout: () => inertSignal,
    sleep: async () => assert.fail("successful unauthenticated API request slept"),
    token: null,
  });
  assert(!("Authorization" in unauthenticatedApiRequest.headers), "tokenless API request invented credentials");
  killed.transportGuards += 1;

  let defaultSignal;
  await fetchPinnedBytes("https://example.invalid/default-timeout", {
    fetchImpl: async (_url, options) => {
      defaultSignal = options.signal;
      return new Response("anchored", { status: 200 });
    },
    sleep: async () => assert.fail("successful default-timeout request slept"),
  });
  assert(defaultSignal instanceof AbortSignal, "default timeout factory was detached from the real request");
  killed.transportGuards += 1;

  const realSetTimeout = globalThis.setTimeout;
  const realAbortTimeout = AbortSignal.timeout;
  const defaultDelayDurations = [];
  const defaultTimeoutDurations = [];
  const defaultTimeoutSignals = [];
  const observedDefaultSignals = [];
  let defaultAttempts = 0;
  try {
    globalThis.setTimeout = (callback, milliseconds) => {
      defaultDelayDurations.push(milliseconds);
      callback();
      return 0;
    };
    AbortSignal.timeout = (milliseconds) => {
      defaultTimeoutDurations.push(milliseconds);
      const signal = AbortSignal.abort(`default-timeout-${defaultTimeoutSignals.length + 1}`);
      defaultTimeoutSignals.push(signal);
      return signal;
    };
    const result = await fetchPinnedBytes("https://example.invalid/default-adapters", {
      fetchImpl: async (_url, options) => {
        defaultAttempts += 1;
        observedDefaultSignals.push(options.signal);
        return defaultAttempts === 1
          ? new Response(null, { status: 503 })
          : new Response("anchored", { status: 200 });
      },
    });
    assert.equal(result.toString(), "anchored", "default transport adapters did not recover");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    AbortSignal.timeout = realAbortTimeout;
  }
  assert.equal(defaultAttempts, 2, "default transport adapters did not retry once");
  assert.deepEqual(defaultDelayDurations, [250], "default scheduler lost its reviewed delay");
  assert.deepEqual(defaultTimeoutDurations, [30_000, 30_000], "default timeout adapter lost its reviewed window");
  assert.deepEqual(observedDefaultSignals, defaultTimeoutSignals, "default timeout signals were not attached per attempt");
  killed.transportGuards += 1;

  for (const url of [
    reportAnchor.url,
    fixAnchors.q3u_publish_only.patchUrl,
    `https://raw.githubusercontent.com/facebook/akd/${releaseAnchors.selected.commit}/${releaseAnchors.path}`,
    "https://api.github.com.evil/evidence",
    "http://api.github.com/evidence",
    "https://api.github.com:444/evidence",
  ]) {
    let request;
    await fetchPinnedBytes(url, {
      fetchImpl: async (actualUrl, options) => {
        request = { options, url: actualUrl };
        return new Response("anchored", { status: 200 });
      },
      signalForTimeout: () => inertSignal,
      sleep: async () => assert.fail("successful third-party request slept"),
      token: "test-token",
    });
    assert.equal(request?.url, url, "real third-party request URL changed");
    assert(!("Authorization" in request.options.headers), `${url} received the GitHub token`);
    killed.transportGuards += 1;
  }

  for (const { headers = {}, status } of [
    { status: 429 },
    { status: 500 },
    { status: 502 },
    { status: 503 },
    { status: 599 },
    { status: 403, headers: { "x-ratelimit-remaining": "0" } },
  ]) {
    let attempts = 0;
    const sleeps = [];
    const value = await fetchPinnedBytes("https://example.invalid/transient", {
      fetchImpl: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response(null, { status, headers })
          : new Response("anchored", { status: 200 });
      },
      signalForTimeout: () => inertSignal,
      sleep: async (milliseconds) => sleeps.push(milliseconds),
    });
    assert.equal(value.toString(), "anchored", `HTTP ${status} did not recover`);
    assert.equal(attempts, 2, `HTTP ${status} did not traverse the real retry path`);
    assert.deepEqual(sleeps, [250], `HTTP ${status} used the wrong retry delay`);
    killed.transportGuards += 1;
  }

  for (const { headers = {}, status } of [
    { status: 400 },
    { status: 401 },
    { status: 404 },
    { status: 403 },
    { status: 403, headers: { "x-ratelimit-remaining": "1" } },
  ]) {
    let attempts = 0;
    const sleeps = [];
    await assert.rejects(
      fetchPinnedBytes("https://example.invalid/permanent", {
        fetchImpl: async () => {
          attempts += 1;
          return new Response(null, { status, headers });
        },
        signalForTimeout: () => inertSignal,
        sleep: async (milliseconds) => sleeps.push(milliseconds),
      }),
      EvidenceTransportError,
      `HTTP ${status} lost its transport verdict`,
    );
    assert.equal(attempts, 1, `HTTP ${status} permanent failure was retried`);
    assert.deepEqual(sleeps, [], `HTTP ${status} permanent failure slept`);
    killed.transportGuards += 1;
  }

  const retryStatuses = [503, 429, 200];
  let retryAttempts = 0;
  const retrySleeps = [];
  const retried = await fetchPinnedBytes("https://example.invalid/backoff", {
    fetchImpl: async () => {
      const status = retryStatuses[retryAttempts];
      retryAttempts += 1;
      return new Response(status === 200 ? "anchored" : null, { status });
    },
    signalForTimeout: () => inertSignal,
    sleep: async (milliseconds) => retrySleeps.push(milliseconds),
  });
  assert.equal(retried.toString(), "anchored", "transient retry did not recover pinned bytes");
  assert.equal(retryAttempts, 3, "transient retry-attempt guard survived");
  assert.deepEqual(retrySleeps, [250, 500], "transient retry-backoff guard survived");
  killed.transportGuards += 1;

  let timeoutAttempts = 0;
  const timeoutSleeps = [];
  const timeoutDurations = [];
  const timeoutRequests = [];
  const timeoutSignals = [];
  const observedTimeoutSignals = [];
  await assert.rejects(
    fetchPinnedJson("https://api.github.com/example", {
      fetchImpl: async (url, options) => {
        timeoutAttempts += 1;
        timeoutRequests.push({ options, url });
        observedTimeoutSignals.push(options.signal);
        throw new DOMException("simulated request timeout", "TimeoutError");
      },
      signalForTimeout: (milliseconds) => {
        timeoutDurations.push(milliseconds);
        const signal = AbortSignal.abort(`timeout-${timeoutSignals.length + 1}`);
        timeoutSignals.push(signal);
        return signal;
      },
      sleep: async (milliseconds) => timeoutSleeps.push(milliseconds),
      token: "test-token",
    }),
    (error) => {
      assert(error instanceof EvidenceTransportError, "timeout lost its error class");
      assert.equal(error.name, "EvidenceTransportError", "timeout lost its error name");
      assert.match(error.message, /^pinned evidence unavailable /, "timeout lost its unavailable verdict");
      assert(!/changed|mismatch|tamper/i.test(error.message), "timeout was mislabeled as evidence drift");
      return true;
    },
  );
  assert.equal(timeoutAttempts, 3, "timeout-exception retry guard survived");
  assert.deepEqual(timeoutSleeps, [250, 500], "timeout-exception backoff guard survived");
  assert.deepEqual(timeoutDurations, [30_000, 30_000, 30_000], "each timeout retry lost its full window");
  assert.deepEqual(observedTimeoutSignals, timeoutSignals, "timeout signals were not attached to their own attempts");
  assert.equal(new Set(observedTimeoutSignals).size, 3, "timeout retries reused an aborted signal");
  assert.deepEqual(timeoutRequests.map(({ url }) => url), Array(3).fill("https://api.github.com/example"), "timeout retries changed URL");
  assert.deepEqual(
    timeoutRequests.map(({ options }) => options.headers.Authorization),
    Array(3).fill("Bearer test-token"),
    "timeout retries lost authenticated headers",
  );
  assert.deepEqual(
    timeoutRequests.map(({ options }) => options.headers.Accept),
    Array(3).fill("application/vnd.github+json"),
    "timeout retries lost JSON media headers",
  );
  killed.transportGuards += 1;

  let exhaustedAttempts = 0;
  await assert.rejects(
    fetchPinnedBytes("https://example.invalid/unavailable", {
      fetchImpl: async () => {
        exhaustedAttempts += 1;
        return new Response(null, { status: 503 });
      },
      signalForTimeout: () => inertSignal,
      sleep: async () => {},
    }),
    (error) => {
      assert(error instanceof EvidenceTransportError, "exhausted HTTP retries lost their transport verdict");
      assert.match(error.message, /pinned evidence unavailable .*HTTP 503/, "exhausted HTTP retries lost their status");
      return true;
    },
  );
  assert.equal(exhaustedAttempts, 3, "transient HTTP retry exhaustion guard survived");
  killed.transportGuards += 1;

  for (const [kind, consumeMethod] of [
    ["byte", "arrayBuffer"],
    ["JSON", "json"],
  ]) {
    let attempts = 0;
    const sleeps = [];
    const options = {
      fetchImpl: async () => {
        attempts += 1;
        return {
          ok: true,
          [consumeMethod]: async () => { throw new TypeError("terminated response body"); },
        };
      },
      signalForTimeout: () => inertSignal,
      sleep: async (milliseconds) => sleeps.push(milliseconds),
    };
    const operation = kind === "byte"
      ? fetchPinnedBytes("https://example.invalid/body", options)
      : fetchPinnedJson("https://example.invalid/body", options);
    await assert.rejects(operation, (error) => {
      assert(error instanceof EvidenceTransportError, `${kind} body transport lost its error class`);
      assert.match(error.message, /pinned evidence unavailable .*terminated response body/, `${kind} body transport lost its verdict`);
      return true;
    });
    assert.equal(attempts, 3, `${kind} body transport was not retried`);
    assert.deepEqual(sleeps, [250, 500], `${kind} body transport used the wrong backoff`);
    killed.transportGuards += 1;
  }

  let malformedJsonAttempts = 0;
  const malformedJsonSleeps = [];
  await assert.rejects(
    fetchPinnedJson("https://example.invalid/malformed-json", {
      fetchImpl: async () => {
        malformedJsonAttempts += 1;
        return new Response("{", { status: 200 });
      },
      signalForTimeout: () => inertSignal,
      sleep: async (milliseconds) => malformedJsonSleeps.push(milliseconds),
    }),
    (error) => {
      assert(error instanceof EvidenceTransportError, "malformed JSON body lost its error class");
      assert.match(error.message, /^pinned evidence unavailable /, "malformed JSON body lost its unavailable verdict");
      return true;
    },
  );
  assert.equal(malformedJsonAttempts, 3, "malformed JSON body was not retried");
  assert.deepEqual(malformedJsonSleeps, [250, 500], "malformed JSON body used the wrong backoff");
  killed.transportGuards += 1;

  const expectedMetrics = metricValues(benchmark);
  for (const [key] of metricInventory) {
    const token = `**${expectedMetrics.get(key)}**<!-- akd-metric:${key} -->`;
    for (const [relativePath, source] of files) {
      let from = 0;
      while (true) {
        const index = source.indexOf(token, from);
        if (index < 0) break;
        const digitOffset = token.search(/[0-9]/);
        const digit = token[digitOffset];
        const replacement = digit === "9" ? "8" : String(Number(digit) + 1);
        const mutated = `${source.slice(0, index + digitOffset)}${replacement}${source.slice(index + digitOffset + 1)}`;
        assert.throws(
          () => validateMetricClaims(files.map(([path, body]) => [path, path === relativePath ? mutated : body]), benchmark),
          `${relativePath}: ${key} displayed-value mutant survived`,
        );
        killed.displayedMetrics += 1;
        from = index + token.length;
      }
    }
  }

  const benchmarkMutants = [
    ["verifier_size_raw", "size_optimized", "raw_bytes"],
    ["verifier_size_gzip", "size_optimized", "gzip_9_bytes"],
    ["verifier_size_brotli", "size_optimized", "brotli_q11_bytes"],
    ["verifier_recommended_raw", "recommended", "raw_bytes"],
    ["verifier_recommended_brotli", "recommended", "brotli_q11_bytes"],
  ];
  for (const [key, profile, field] of benchmarkMutants) {
    const mutant = structuredClone(benchmark);
    mutant.verifier_bundles[profile][field] += 1;
    assert.throws(() => validateMetricClaims(files, mutant), `${key} benchmark-artifact mutant survived`);
    killed.benchmarkArtifacts += 1;
  }

  const benchmarkMutant = structuredClone(benchmark);
  benchmarkMutant.verifier_bundles.recommended.raw_bytes += 1;
  const coordinatedMetricFiles = files.map(([path, source]) => [
    path,
    source.replaceAll(
      "**183,375 B**<!-- akd-metric:verifier_recommended_raw -->",
      "**183,376 B**<!-- akd-metric:verifier_recommended_raw -->",
    ),
  ]);
  validateMetricClaims(coordinatedMetricFiles, benchmarkMutant);
  assert.throws(
    () => validateBenchmarkAnchor(benchmarkMutant, benchmarkComment),
    "coordinated benchmark-artifact and documentation mutant survived immutable comment evidence",
  );
  killed.coordinatedEvidence += 1;
  const commentIdentityMutant = structuredClone(benchmarkComment);
  commentIdentityMutant.node_id = "MUTANT";
  assert.throws(
    () => validateBenchmarkAnchor(benchmark, commentIdentityMutant),
    "benchmark comment-identity mutant survived",
  );
  killed.coordinatedEvidence += 1;

  for (const [key, relativePath] of claimInventory) {
    const end = key === "audit_scope" ? `<!-- akd-claim:${key}:end -->` : expectedHistoryClaim();
    const mutatedFiles = files.map(([path, source]) => [
      path,
      path === relativePath
        ? source.replace(
            end,
            key === "audit_scope" ? `MUTANT\n${end}` : end.replace("HistoryProof", "HistoryProofV2"),
          )
        : source,
    ]);
    assert.throws(() => validateClaimBlocks(mutatedFiles, audit), `${key} prose mutant survived`);
    killed.claims += 1;
  }


  const reportMutant = structuredClone(audit);
  reportMutant.report.finding = "NCC-E008327-NONEXISTENT";
  const coordinatedReportFiles = files.map(([path, source]) => [
    path,
    path === claimInventory.get("audit_scope")
      ? replaceClaimBlock(source, "audit_scope", expectedAuditClaim(reportMutant))
      : source,
  ]);
  validateClaimBlocks(coordinatedReportFiles, reportMutant);
  assert.throws(() => validateReportRecord(reportMutant), "coordinated nonexistent report finding survived");
  killed.coordinatedEvidence += 1;

  const { bodies, fixEvidence, report, reportStructure, sources } = await validateAuditEvidence(audit);
  assert.throws(
    () => validateReportSemantics(
      Buffer.from(
        reportStructure.replace(
          "/Title (Multiple Key Updates During Epoch Results in Invalid State)",
          "/Title (MUTANT)",
        ),
        "latin1",
      ),
    ),
    "NCC finding-title semantic mutant survived dependency-free PDF validation",
  );
  killed.coordinatedEvidence += 1;

  const savedPath = process.env.PATH;
  process.env.PATH = "";
  try {
    validateReportSemantics(report);
  } finally {
    process.env.PATH = savedPath;
  }
  killed.coordinatedEvidence += 1;

  for (const [name, replacementNumber] of [
    ["q3u_publish_only", 399],
    ["auditor_residual", 494],
  ]) {
    const fixMutant = structuredClone(audit);
    fixMutant.fixes[name].url = `https://github.com/facebook/akd/pull/${replacementNumber}`;
    const coordinatedFixFiles = files.map(([path, source]) => [
      path,
      path === claimInventory.get("audit_scope")
        ? replaceClaimBlock(source, "audit_scope", expectedAuditClaim(fixMutant))
        : source,
    ]);
    validateClaimBlocks(coordinatedFixFiles, fixMutant);
    assert.throws(
      () => validateFixRecords(fixMutant),
      `coordinated ${name} PR URL and ADR-link mutant survived`,
    );
    killed.coordinatedEvidence += 1;

    const { patch, pull } = fixEvidence[name];
    const anchor = fixAnchors[name];
    const pullMutant = structuredClone(pull);
    pullMutant.number = replacementNumber;
    assert.throws(
      () => validatePullRequestIdentity(pullMutant, anchor),
      `${name} PR identity mutant survived`,
    );
    const semanticMutant = Buffer.from(
      patch.toString("utf8").replace(anchor.requiredPatchText[1], "MUTATED SEMANTIC"),
    );
    assert.notDeepEqual(semanticMutant, patch, `${name} patch semantic mutant was not constructed`);
    const reanchoredPatch = { ...anchor, patchSha256: sha256(semanticMutant) };
    assert.throws(
      () => validateFixPatch(semanticMutant, reanchoredPatch),
      `${name} patch semantic mutant survived after coordinating its byte hash`,
    );
    killed.coordinatedEvidence += 2;
  }

  const releaseMutant = structuredClone(audit);
  releaseMutant.upstream.audited = structuredClone(releaseMutant.upstream.selected);
  const coordinatedReleaseFiles = files.map(([path, source]) => [
    path,
    path === claimInventory.get("audit_scope")
      ? replaceClaimBlock(source, "audit_scope", expectedAuditClaim(releaseMutant))
      : source,
  ]);
  validateClaimBlocks(coordinatedReleaseFiles, releaseMutant);
  assert.throws(
    () => validateReleaseRecords(releaseMutant),
    "coordinated release re-anchor survived immutable tag identities",
  );
  assert.throws(
    () => validateDistinctVersionSources([sources[1], sources[1]]),
    "single source aliased as two releases survived",
  );
  killed.coordinatedEvidence += 2;
  const validTagRefs = [
    `${releaseAnchors.audited.commit}\trefs/tags/${releaseAnchors.audited.release}`,
    `${releaseAnchors.selected.commit}\trefs/tags/${releaseAnchors.selected.release}`,
  ].join("\n");
  validateTagRefs(validTagRefs);
  assert.throws(
    () => validateTagRefs(validTagRefs.replace(releaseAnchors.audited.commit, releaseAnchors.selected.commit)),
    "AKD tag-to-commit re-anchor mutant survived",
  );
  killed.coordinatedEvidence += 1;
  const selected = audit.upstream.selected;
  const selectedMutant = Buffer.from(sources[1].toString("utf8").replace("PrefixOrdering::Invalid => true", "PrefixOrdering::Invalid => false"));
  assert.notDeepEqual(selectedMutant, sources[1], "failed to construct pinned-source mutant");
  assert.throws(
    () => validatePinnedSource(selectedMutant, selected, audit.upstream.partition_signature, audit.upstream.partition_body_sha256),
    (error) => {
      assert(
        !(error instanceof EvidenceTransportError),
        "pinned-source drift was mislabeled as transport unavailability",
      );
      assert.match(error.message, /raw source hash changed/, "pinned-source drift lost its digest verdict");
      return true;
    },
    "pinned-source byte mutant survived",
  );
  killed.pinnedSource += 1;
  const reanchoredSelected = {
    ...selected,
    raw_sha256: sha256(selectedMutant),
    git_blob_sha1: gitBlobSha1(selectedMutant),
  };
  const selectedMutantBody = validatePinnedSource(
    selectedMutant,
    reanchoredSelected,
    audit.upstream.partition_signature,
    sha256(extractRustFunction(selectedMutant.toString("utf8"), audit.upstream.partition_signature)),
  );
  assert.throws(
    () => validatePartitionEquality([bodies[0], selectedMutantBody]),
    "partition-body equality mutant survived after re-anchoring source hashes",
  );
  killed.pinnedSource += 1;

  const api = await readFile(apiPath, "utf8");
  await compileApiFixture(api, true);
  const compileMutant = await compileApiFixture(api.replaceAll("HistoryProof", "HistoryProofV2"), false);
  assert.match(compileMutant.stderr, /HistoryProofV2/, "compile mutant failed for an unrelated reason");
  killed.compileApi += 1;
  process.stdout.write(`AKD documentation evidence self-test observed every mutant fail: ${JSON.stringify(killed)}\n`);
}

const argument = process.argv[2];
if (argument === undefined) await live();
else if (argument === "--self-test") await selfTest();
else {
  process.stderr.write("usage: check-akd-doc-evidence.mjs [--self-test]\n");
  process.exitCode = 2;
}
