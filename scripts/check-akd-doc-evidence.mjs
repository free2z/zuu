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
  ["history_request_wire", "docs/e2ee/KT.md"],
  ["enumeration_boundary_kt", "docs/e2ee/KT.md"],
  ["enumeration_boundary_adr", "docs/e2ee/decisions/0013-key-transparency-log.md"],
]);

const requiredClaimInventory = new Map([
  ["audit_scope", "docs/e2ee/decisions/0013-key-transparency-log.md"],
  ["history_proof_type", "docs/e2ee/KT.md"],
  ["history_request_wire", "docs/e2ee/KT.md"],
  ["enumeration_boundary_kt", "docs/e2ee/KT.md"],
  ["enumeration_boundary_adr", "docs/e2ee/decisions/0013-key-transparency-log.md"],
]);

const enumerationClaimContexts = new Map([
  [
    "enumeration_boundary_kt",
    Object.freeze({
      before:
        "[`THREAT-MODEL.md` §4.1](./THREAT-MODEL.md#41-directory-lookup-reveals-interest-in-a-handle).\n\n",
      after: "\n\n---\n\n## 4. `DirectoryEntry`",
      markerIndent: "",
      outerHeading: "3. What `akd` provides, and what we add",
      outerHeadingOrdinal: 2,
      sectionHeading: "3.3 Label and value",
      sectionHeadingOrdinal: 2,
      followingHeading: "4. `DirectoryEntry`",
    }),
  ],
  [
    "enumeration_boundary_adr",
    Object.freeze({
      before:
        "RFC 6962, which is why the fallback above pairs it with a VRF and a commitment.\n\n  ",
      after: "\n\n- **Full hand-rolled SEEMless.**",
      markerIndent: "  ",
      outerHeading: "Alternatives rejected",
      outerHeadingOrdinal: 3,
      itemStart: "- **A plain cleartext RFC 6962 log.**",
      itemEnd: "- **Full hand-rolled SEEMless.**",
    }),
  ],
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

function claimBounds(source, key) {
  const start = `<!-- akd-claim:${key}:start -->`;
  const end = `<!-- akd-claim:${key}:end -->`;
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end);
  assert(startIndex >= 0 && endIndex > startIndex, `missing complete ${key} claim block`);
  assert.equal(source.indexOf(start, startIndex + 1), -1, `duplicate ${key} claim start`);
  assert.equal(source.indexOf(end, endIndex + 1), -1, `duplicate ${key} claim end`);
  return { start, end, startIndex, endIndex };
}

function claimBlock(source, key) {
  const { start, endIndex, startIndex } = claimBounds(source, key);
  return source
    .slice(startIndex + start.length, endIndex)
    .trim()
    .split("\n")
    .map((line) => line.trimStart())
    .join("\n");
}

function markdownLines(source) {
  return [...source.matchAll(/[^\n]*(?:\n|$)/g)]
    .filter((match) => match[0] !== "")
    .map((match) => ({
      index: match.index,
      line: match[0].endsWith("\n") ? match[0].slice(0, -1) : match[0],
      hasNewline: match[0].endsWith("\n"),
    }));
}

function markdownContainerAt(containers, index) {
  return containers.find(({ start, end }) => index >= start && index < end) ?? null;
}

function markdownLineInContainer(line, container) {
  if (container === null || container.indent === 0 || line.trim() === "") return line;
  const prefix = " ".repeat(container.indent);
  return line.startsWith(prefix) ? line.slice(container.indent) : line;
}

function markdownFenceCandidate(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  return {
    character: match[1][0],
    length: match[1].length,
    rest: match[2],
  };
}

function nextMarkdownFence(fence, line, container = null) {
  // A block nested in a list item cannot consume the next sibling item. Reset
  // an unterminated fence when its reviewed container ends, just as CommonMark
  // does after removing the list's content indentation.
  if (fence !== null && fence.container !== container) fence = null;
  const candidate = markdownFenceCandidate(line);
  if (!candidate) return fence;
  if (fence === null) {
    // CommonMark forbids backticks in a backtick fence's info string. Tilde
    // fences have no corresponding restriction.
    if (candidate.character === "`" && candidate.rest.includes("`")) return null;
    return { character: candidate.character, length: candidate.length, container };
  }
  // A closing fence uses the same character, is at least as long as its opener,
  // and has no info string: only spaces or tabs may follow it.
  if (
    candidate.character === fence.character
    && candidate.length >= fence.length
    && /^[ \t]*$/.test(candidate.rest)
  ) {
    return null;
  }
  return fence;
}

function markdownFenceAt(source, index, containers = []) {
  let fence = null;
  for (const entry of markdownLines(source)) {
    if (entry.index >= index) break;
    const container = markdownContainerAt(containers, entry.index);
    fence = nextMarkdownFence(
      fence,
      markdownLineInContainer(entry.line, container),
      container,
    );
  }
  return fence !== null && fence.container === markdownContainerAt(containers, index)
    ? fence
    : null;
}

function insideMarkdownFence(source, index, containers = []) {
  return markdownFenceAt(source, index, containers) !== null;
}

function maskMarkdownFences(source, containers = []) {
  let fence = null;
  let masked = "";
  for (const entry of markdownLines(source)) {
    const { hasNewline, index, line } = entry;
    const container = markdownContainerAt(containers, index);
    const effectiveLine = markdownLineInContainer(line, container);
    const wasInside = fence !== null && fence.container === container;
    fence = nextMarkdownFence(fence, effectiveLine, container);
    const isFenceLine = markdownFenceCandidate(effectiveLine) !== null && (wasInside || fence !== null);
    masked += wasInside || isFenceLine ? " ".repeat(line.length) : line;
    if (hasNewline) masked += "\n";
  }
  return masked;
}

function markdownHeadings(source, containers = []) {
  const headings = [];
  // CommonMark permits up to three leading spaces before an ATX heading. A
  // structural census that recognises only column zero lets an ordinary
  // one-space H2 move a claim while remaining invisible to its ordinal check.
  const atxPattern = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
  const lines = markdownLines(source);
  for (const entry of lines) {
    const container = markdownContainerAt(containers, entry.index);
    const match = atxPattern.exec(markdownLineInContainer(entry.line, container));
    if (match === null) continue;
    if (
      !insideMarkdownFence(source, entry.index, containers)
      && !insideSpecialRawHtmlBlock(source, entry.index, containers)
      && openRawHtmlContainers(source, entry.index, containers).length === 0
    ) {
      const text = (match[2] ?? "")
        .replace(/(?:^|[ \t]+)#+[ \t]*$/, "")
        .trimEnd();
      headings.push({ index: entry.index, level: match[1].length, text });
    }
  }
  // Setext headings are normative section boundaries too. Ignoring them lets
  // an unrelated rendered H2 sit between the reviewed ATX heading and claim
  // while the raw-source census still reports the older section as preceding.
  const setextUnderlinePattern = /^ {0,3}(=+|-+)[ \t]*$/;
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const entry = lines[lineIndex];
    const previous = lines[lineIndex - 1];
    const container = markdownContainerAt(containers, entry.index);
    if (container !== markdownContainerAt(containers, previous.index)) continue;
    const underline = setextUnderlinePattern.exec(markdownLineInContainer(entry.line, container));
    const textLine = markdownLineInContainer(previous.line, container);
    if (underline === null || !/^ {0,3}\S/.test(textLine)) continue;
    if (
      !insideMarkdownFence(source, previous.index, containers)
      && !insideSpecialRawHtmlBlock(source, previous.index, containers)
      && openRawHtmlContainers(source, previous.index, containers).length === 0
    ) {
      headings.push({
        index: previous.index,
        level: underline[1][0] === "=" ? 1 : 2,
        text: textLine.trimStart().trimEnd(),
      });
    }
  }
  return headings.sort((left, right) => left.index - right.index);
}

function markdownListItemStarts(source, fromIndex = 0) {
  const region = source.slice(fromIndex);
  const candidates = [...region.matchAll(/^( *)([-+*]|\d{1,9}[.)])(?:([ \t]+)([^\n]*))?$/gm)]
    .filter((match) => {
      const index = fromIndex + match.index;
      return !insideMarkdownFence(source, index)
        && !insideSpecialRawHtmlBlock(source, index)
        && openRawHtmlContainers(source, index).length === 0;
    })
    .map((match) => ({
      index: fromIndex + match.index,
      indent: match[1].length,
      contentIndent: match[1].length + match[2].length
        + (match[3] && match[3].length <= 4 ? match[3].length : 1),
      marker: match[2],
      text: match[0].slice(match[1].length),
    }));

  // This document's alternatives form one root list. Once its first item fixes
  // the content column, another marker before that column is a sibling/root
  // boundary; a marker at or beyond it is nested content and must not displace
  // the containing alternative.
  const firstRoot = candidates.find(({ indent }) => indent <= 3);
  if (!firstRoot) return [];
  return candidates.filter(({ indent }) => indent < firstRoot.contentIndent);
}

function insideRawHtmlComment(source, index, containers = []) {
  const prefix = maskMarkdownFences(source, containers).slice(0, index);
  return prefix.lastIndexOf("<!--") > prefix.lastIndexOf("-->");
}

function unclosedDelimitedRawBlock(prefix, opening, closing) {
  const start = prefix.lastIndexOf(opening);
  return start >= 0 && prefix.indexOf(closing, start + opening.length) < 0;
}

function insideSpecialRawHtmlBlock(source, index, containers = []) {
  const prefix = maskMarkdownFences(source, containers).slice(0, index);
  if (
    unclosedDelimitedRawBlock(prefix, "<!--", "-->")
    || unclosedDelimitedRawBlock(prefix, "<?", "?>")
    || unclosedDelimitedRawBlock(prefix, "<![CDATA[", "]]>")
  ) {
    return true;
  }
  const declarations = [...prefix.matchAll(/<![A-Z]/g)];
  const declaration = declarations.at(-1);
  return declaration !== undefined && prefix.indexOf(">", declaration.index + 3) < 0;
}

// CommonMark 0.31.2 §4.6 type-1 containers plus the complete type-6 block-tag
// inventory. Extra semantic containers used by GitHub Markdown remain included
// fail-closed: a reviewed normative claim must be ordinary rendered Markdown,
// never raw HTML whose display or hierarchy depends on a sanitizer/browser.
const rawHtmlBlockTags = new Set([
  "address",
  "article",
  "aside",
  "base",
  "basefont",
  "body",
  "blockquote",
  "caption",
  "center",
  "code",
  "col",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hr",
  "html",
  "iframe",
  "legend",
  "li",
  "link",
  "main",
  "menu",
  "menuitem",
  "nav",
  "noframes",
  "noscript",
  "object",
  "ol",
  "optgroup",
  "option",
  "p",
  "param",
  "pre",
  "script",
  "search",
  "section",
  "span",
  "style",
  "summary",
  "table",
  "tbody",
  "td",
  "template",
  "tfoot",
  "th",
  "thead",
  "title",
  "track",
  "tr",
  "ul",
  "textarea",
]);
const rawHtmlVoidTags = new Set([
  "base",
  "basefont",
  "col",
  "frame",
  "hr",
  "link",
  "menuitem",
  "param",
  "track",
]);
const rawHtmlContainerPattern = new RegExp(
  `<\\s*\\/?\\s*(?:${[...rawHtmlBlockTags].join("|")})\\b`,
  "i",
);

function rawHtmlTagTokens(source) {
  const tokens = [];
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== "<") continue;
    let cursor = start + 1;
    let closing = false;
    if (source[cursor] === "/") {
      closing = true;
      cursor += 1;
    }
    // HTML tag names begin immediately after `<` or `</`. Accepting whitespace
    // here lets a browser-visible malformed close such as `</ details>` pop a
    // container in the policy parser even though it does not close the element.
    if (!/[A-Za-z]/.test(source[cursor] ?? "")) continue;
    const nameStart = cursor;
    cursor += 1;
    while (/[A-Za-z0-9-]/.test(source[cursor] ?? "")) cursor += 1;
    const name = source.slice(nameStart, cursor).toLowerCase();
    if (!/[\s/>]/.test(source[cursor] ?? "")) continue;

    let quote = null;
    let end = -1;
    for (; cursor < source.length; cursor += 1) {
      const character = source[cursor];
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        end = cursor;
        break;
      }
    }
    if (end < 0) continue;
    const tail = source.slice(nameStart + name.length, end);
    if (closing && !/^\s*$/.test(tail)) {
      // End tags have no attributes or self-closing slash. Fail closed: do not
      // let a malformed spelling alter the reviewed container stack.
      continue;
    }
    tokens.push({
      start,
      end: end + 1,
      name,
      closing,
      selfClosing: !closing && /\/\s*$/.test(tail),
    });
    start = end;
  }
  return tokens;
}

function openRawHtmlContainers(source, index, containers = []) {
  const stack = [];
  const prefix = maskMarkdownFences(source, containers)
    .slice(0, index)
    .replace(/<!--[\s\S]*?-->/g, "");
  for (const token of rawHtmlTagTokens(prefix)) {
    const { closing, name, selfClosing } = token;
    if (!rawHtmlBlockTags.has(name)) continue;
    if (closing) {
      const position = stack.lastIndexOf(name);
      if (position >= 0) stack.splice(position, 1);
    } else if (!rawHtmlVoidTags.has(name) && !selfClosing) {
      stack.push(name);
    }
  }
  return stack;
}

function stripClosedSpecialRawMarkup(line) {
  return line
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\?[\s\S]*?\?>/g, " ")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ")
    .replace(/<![A-Z][^>]*>/g, " ");
}

function visibleMarkdownBlocks(source, key, protectedContext) {
  const { containers, protectedEnd, protectedStart } = protectedContext;
  const { end, endIndex, start, startIndex } = claimBounds(source, key);
  const ignoredStart = source.lastIndexOf("\n", startIndex - 1) + 1;
  const ignoredEndLine = source.indexOf("\n", endIndex + end.length);
  const ignoredEnd = ignoredEndLine < 0 ? source.length : ignoredEndLine + 1;
  const blocks = [];
  let block = [];
  const finishBlock = () => {
    if (block.length > 0) blocks.push(block.join(" ").replace(/\s+/g, " ").trim());
    block = [];
  };

  for (const entry of markdownLines(source)) {
    if (entry.index < protectedStart || entry.index >= protectedEnd) continue;
    if (entry.index >= ignoredStart && entry.index < ignoredEnd) {
      finishBlock();
      continue;
    }
    const container = markdownContainerAt(containers, entry.index);
    const effectiveLine = markdownLineInContainer(entry.line, container);
    const fenced = insideMarkdownFence(source, entry.index, containers);
    if (fenced || markdownFenceCandidate(effectiveLine) !== null) {
      finishBlock();
      continue;
    }
    if (insideSpecialRawHtmlBlock(source, entry.index, containers)) {
      finishBlock();
      continue;
    }
    if (openRawHtmlContainers(source, entry.index, containers).length > 0) {
      finishBlock();
      continue;
    }
    const withoutSpecial = stripClosedSpecialRawMarkup(effectiveLine);
    const htmlTokens = rawHtmlTagTokens(withoutSpecial);
    if (htmlTokens.length > 0) {
      assert.equal(
        htmlTokens.length,
        0,
        `${key} contains raw HTML in its protected rendered section`,
      );
    }
    const visible = withoutSpecial.trim();
    if (visible === "") {
      finishBlock();
    } else {
      block.push(visible);
    }
  }
  finishBlock();
  return blocks;
}

const enumerationLanguage = String.raw`(?:enumerat(?:e|ed|es|ing|ion)|reconstruct(?:s|ed|ing|ion)?|per[- ]handle\s+discover(?:y|ability)|handle[- ]by[- ]handle|lookups?)`;
const privacyTargets = String.raw`(?:membership|device(?:\s+count|\s+metadata|\s+credentials?)?|credentials?|contact\s+endpoints?|metadata|(?:queried|known|guessed|public)\s+(?:handles?|entries|users?))`;
const preventionLanguage = String.raw`(?:prevent(?:s|ed|ing)?|block(?:s|ed|ing)?|stop(?:s|ped|ping)?|preclud(?:e|es|ed|ing)|defeat(?:s|ed|ing)?|eliminat(?:e|es|ed|ing)|thwart(?:s|ed|ing)?)`;
const strongPrivacyLanguage = String.raw`(?:cryptograph(?:ic|ically)\s+(?:private|hidden|protected|concealed|confidential)|non[- ]enumerable|unobservable|undiscoverable|guarantee(?:s|d)?\s+(?:privacy|confidentiality)|conceal(?:s|ed|ing)?|keep(?:s|ing)?\s+secret)`;
const enumerationOverclaimPatterns = [
  new RegExp(`\\b${preventionLanguage}\\b.{0,140}\\b${enumerationLanguage}\\b`, "i"),
  new RegExp(`\\b${enumerationLanguage}\\b.{0,140}\\b${preventionLanguage}\\b`, "i"),
  new RegExp(`\\b${privacyTargets}\\b.{0,140}\\b${strongPrivacyLanguage}\\b`, "i"),
  new RegExp(`\\b${strongPrivacyLanguage}\\b.{0,140}\\b${privacyTargets}\\b`, "i"),
  /\brate\s+limit(?:s|ing)?\b.{0,140}\b(?:cryptographic\s+guarantee|guarantee(?:s|d)?\s+privacy|prevent(?:s|ed|ing)?\s+(?:enumeration|reconstruction))\b/i,
];
const visibleEnumerationContextDigests = new Map([
  ["enumeration_boundary_kt", "2c518de6d0ad6031e7e5e3a36647f0206d8ec9e341f1f032763792ed234a0225"],
  ["enumeration_boundary_adr", "4786e1b13446163cece6656daa6aaa8273da23eb284edd588189e0396ec376be"],
]);

function validateNoVisibleEnumerationContradictions(source, key, protectedContext) {
  const blocks = visibleMarkdownBlocks(source, key, protectedContext);
  for (const block of blocks) {
    for (const pattern of enumerationOverclaimPatterns) {
      const match = pattern.exec(block);
      if (match === null) continue;
      const prefix = block.slice(Math.max(0, match.index - 32), match.index + 32);
      if (/\b(?:does?|do|is|are|can|will|would)\s+not\b|\b(?:never|cannot|can't|doesn't)\b/i.test(prefix)) {
        continue;
      }
      assert.fail(`${key} contains a visible enumeration-privacy overclaim: ${match[0]}`);
    }
  }
  assert.equal(
    sha256(JSON.stringify(blocks)),
    visibleEnumerationContextDigests.get(key),
    `${key} visible surrounding prose changed; review it for enumeration-privacy contradictions`,
  );
}

function validateEnumerationSection(source, key, startIndex, endIndex) {
  const context = enumerationClaimContexts.get(key);
  let containers = [];
  let headings = markdownHeadings(source);
  let bullets = null;
  let precedingItem = null;
  let followingItem = null;

  if (key === "enumeration_boundary_adr") {
    const baseOuterHeading = headings.filter(
      ({ level, text }) => level === 2 && text === context.outerHeading,
    ).at(0);
    assert(baseOuterHeading, `${key} lacks its outer section`);
    bullets = markdownListItemStarts(source, baseOuterHeading.index);
    precedingItem = bullets.filter(({ index }) => index < startIndex).at(-1);
    followingItem = bullets.find(({ index }) => index > endIndex);
    assert(
      precedingItem?.text.startsWith(context.itemStart),
      `${key} is outside the cleartext-log alternative`,
    );
    assert(
      followingItem?.text.startsWith(context.itemEnd),
      `${key} crossed the cleartext-log alternative boundary`,
    );
    containers = bullets.map((item, itemIndex) => {
      const bodyStart = source.indexOf("\n", item.index);
      assert(bodyStart >= 0, `${key} alternative lacks a body`);
      return {
        start: bodyStart + 1,
        end: bullets[itemIndex + 1]?.index ?? source.length,
        indent: item.contentIndent,
      };
    });
    // CommonMark removes a list item's content indentation before parsing its
    // child blocks. Re-run the heading census through that container view so a
    // raw 4/5-space ATX or Setext heading cannot become rendered structure that
    // the policy mistakes for ordinary indented text.
    headings = markdownHeadings(source, containers);
  }

  const h2s = headings.filter(({ level }) => level === 2);
  assert.equal(
    h2s.filter(({ text }) => text === context.outerHeading).length,
    1,
    `${key} outer section heading must be unique`,
  );
  assert.equal(
    h2s[context.outerHeadingOrdinal]?.text,
    context.outerHeading,
    `${key} outer section moved from its reviewed document ordinal`,
  );
  const precedingH2 = h2s.filter(({ index }) => index < startIndex).at(-1);
  assert.equal(
    precedingH2?.text,
    context.outerHeading,
    `${key} is outside its required outer section`,
  );

  if (key === "enumeration_boundary_kt") {
    assert.equal(
      h2s.filter(({ text }) => text === context.followingHeading).length,
      1,
      `${key} following section boundary must be unique`,
    );
    const followingH2 = h2s.find(({ index }) => index > endIndex);
    assert.equal(
      followingH2?.text,
      context.followingHeading,
      `${key} crossed its outer section boundary`,
    );
    const h3s = headings.filter(
      ({ level, index }) => level === 3 && index > precedingH2.index && index < followingH2.index,
    );
    assert.equal(
      h3s.filter(({ text }) => text === context.sectionHeading).length,
      1,
      `${key} subsection heading must be unique`,
    );
    assert.equal(
      h3s[context.sectionHeadingOrdinal]?.text,
      context.sectionHeading,
      `${key} subsection moved from its reviewed ordinal`,
    );
    assert.equal(
      h3s.filter(({ index }) => index < startIndex).at(-1)?.text,
      context.sectionHeading,
      `${key} is outside its required subsection`,
    );
    assert.equal(
      headings.find(({ index }) => index > endIndex)?.text,
      context.followingHeading,
      `${key} is not the final normative paragraph of its subsection`,
    );
    return {
      containers,
      protectedStart: h3s.find(({ text }) => text === context.sectionHeading).index,
      protectedEnd: followingH2.index,
    };
  }

  assert.equal(
    h2s.at(-1)?.text,
    context.outerHeading,
    `${key} outer section must retain its document boundary`,
  );
  assert(bullets !== null, `${key} list structure was not initialized`);
  assert.equal(
    bullets.filter(({ text }) => text.startsWith(context.itemStart)).length,
    1,
    `${key} cleartext-log alternative must be unique`,
  );
  assert.equal(
    bullets.filter(({ text }) => text.startsWith(context.itemEnd)).length,
    1,
    `${key} following alternative boundary must be unique`,
  );
  assert(
    precedingItem?.text.startsWith(context.itemStart),
    `${key} is outside the cleartext-log alternative`,
  );
  assert(
    followingItem?.text.startsWith(context.itemEnd),
    `${key} crossed the cleartext-log alternative boundary`,
  );
  return {
    containers,
    protectedStart: h2s.at(-1).index,
    protectedEnd: source.length,
  };
}

function validateEnumerationClaimContext(source, key) {
  const context = enumerationClaimContexts.get(key);
  assert(context, `missing structural context for ${key}`);
  const { start, end, startIndex, endIndex } = claimBounds(source, key);

  assert.equal(
    source.split(context.before).length - 1,
    1,
    `${key} preceding structural anchor must be unique`,
  );
  assert.equal(
    source.split(context.after).length - 1,
    1,
    `${key} following structural anchor must be unique`,
  );

  assert.equal(
    source.slice(startIndex - context.before.length, startIndex),
    context.before,
    `${key} moved away from its reviewed preceding context`,
  );
  assert.equal(
    source.slice(endIndex + end.length, endIndex + end.length + context.after.length),
    context.after,
    `${key} moved away from its reviewed following context`,
  );
  const protectedContext = validateEnumerationSection(source, key, startIndex, endIndex);
  const { containers } = protectedContext;

  const markerLineStart = source.lastIndexOf("\n", startIndex - 1) + 1;
  assert.equal(
    source.slice(markerLineStart, startIndex),
    context.markerIndent,
    `${key} marker is indented into a quote or code/example context`,
  );
  assert(!insideMarkdownFence(source, startIndex, containers), `${key} is inside a fenced code/example block`);
  assert(!insideMarkdownFence(source, endIndex, containers), `${key} ends inside a fenced code/example block`);
  assert(!insideSpecialRawHtmlBlock(source, startIndex, containers), `${key} is inside a raw HTML block`);
  assert(!insideSpecialRawHtmlBlock(source, endIndex, containers), `${key} ends inside a raw HTML block`);
  assert.deepEqual(
    openRawHtmlContainers(source, startIndex, containers),
    [],
    `${key} is inside a raw HTML disclosure or container`,
  );
  assert.deepEqual(
    openRawHtmlContainers(source, endIndex, containers),
    [],
    `${key} ends inside a raw HTML disclosure or container`,
  );

  const rawClaim = source.slice(startIndex + start.length, endIndex);
  assert(
    !rawHtmlContainerPattern.test(rawClaim),
    `${key} contains a raw HTML disclosure or container`,
  );
  for (const line of rawClaim.split("\n")) {
    if (line.trim() === "") continue;
    assert(
      line.startsWith(context.markerIndent),
      `${key} prose escaped its containing structural indentation`,
    );
    const prose = line.slice(context.markerIndent.length);
    assert(
      !/^ {0,3}>|^ {0,3}(?:`{3,}|~{3,})|^ {4}|^\t/.test(prose),
      `${key} is quoted or rendered as code/example text`,
    );
  }
  validateNoVisibleEnumerationContradictions(source, key, protectedContext);
}

function replaceClaimBlock(source, key, replacement) {
  const start = `<!-- akd-claim:${key}:start -->`;
  const end = `<!-- akd-claim:${key}:end -->`;
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert(startIndex >= 0 && endIndex > startIndex, `cannot replace incomplete ${key} claim block`);
  return `${source.slice(0, startIndex + start.length)}\n${replacement}\n${source.slice(endIndex)}`;
}

function removeClaimBlock(source, key) {
  const start = `<!-- akd-claim:${key}:start -->`;
  const end = `<!-- akd-claim:${key}:end -->`;
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert(startIndex >= 0 && endIndex > startIndex, `cannot remove incomplete ${key} claim block`);
  return `${source.slice(0, startIndex)}${source.slice(endIndex + end.length)}`;
}

function fenceClaimInPlace(source, key) {
  const context = enumerationClaimContexts.get(key);
  assert(context, `missing structural context for ${key}`);
  const { end, endIndex, startIndex } = claimBounds(source, key);
  const beforeStart = startIndex - context.before.length;
  const fenceStart = source.lastIndexOf("\n", beforeStart - 1) + 1;
  const afterEnd = endIndex + end.length + context.after.length;
  const followingNewline = source.indexOf("\n", afterEnd);
  const fenceEnd = followingNewline < 0 ? source.length : followingNewline + 1;
  const fence = `${context.markerIndent}\`\`\`markdown`;
  return `${source.slice(0, fenceStart)}${fence}\n${source.slice(fenceStart, fenceEnd)}${fence}\n${source.slice(fenceEnd)}`;
}

function claimTrioBounds(source, key) {
  const context = enumerationClaimContexts.get(key);
  assert(context, `missing structural context for ${key}`);
  const { end, endIndex, startIndex } = claimBounds(source, key);
  return {
    startIndex: startIndex - context.before.length,
    endIndex: endIndex + end.length + context.after.length,
  };
}

function wrapClaimTrio(source, key, opening, closing) {
  const bounds = claimTrioBounds(source, key);
  return `${source.slice(0, bounds.startIndex)}${opening}\n${source.slice(bounds.startIndex, bounds.endIndex)}\n${closing}${source.slice(bounds.endIndex)}`;
}

function relocateClaimTrio(source, key, wrapper = null, replacement = "") {
  const bounds = claimTrioBounds(source, key);
  const trio = source.slice(bounds.startIndex, bounds.endIndex);
  const relocated = wrapper === null ? trio : `${wrapper.opening}\n${trio}\n${wrapper.closing}`;
  return `${source.slice(0, bounds.startIndex)}${replacement}${source.slice(bounds.endIndex)}\n\n${relocated}\n`;
}

function hideClaimTrioBehindMalformedFence(source, key) {
  const bounds = claimTrioBounds(source, key);
  const start = source.lastIndexOf("\n", bounds.startIndex - 1) + 1;
  const followingNewline = source.indexOf("\n", bounds.endIndex);
  const end = followingNewline < 0 ? source.length : followingNewline;
  const indent = enumerationClaimContexts.get(key).markerIndent;
  const contradiction = key === "enumeration_boundary_kt"
    ? "The zero-knowledge set prevents handle-by-handle reconstruction and makes queried membership and device metadata cryptographically private."
    : "  The zero-knowledge set prevents reconstruction and cryptographically conceals membership and metadata for every queried public handle.";
  return [
    source.slice(0, start),
    `${indent}\`\`\`markdown\n`,
    `${indent}\`\`\` this is literal code, not a closing fence\n`,
    source.slice(start, end),
    `\n${indent}\`\`\`\n\n`,
    `${contradiction}\n`,
    source.slice(end + (followingNewline < 0 ? 0 : 1)),
  ].join("");
}

function spoofClaimStructureWithHiddenTokens(source, key) {
  if (key === "enumeration_boundary_kt") {
    return source.replace(
      "### 3.3 Label and value",
      "#### 3.4 Unrelated implementation note\n\n<!--\n### 3.3 Label and value\n-->",
    );
  }
  return source
    .replace(
      "## Alternatives rejected",
      "### Unrelated implementation appendix\n\n<!--\n## Alternatives rejected\n-->",
    )
    .replace(
      "- **A plain cleartext RFC 6962 log.**",
      "- **An unrelated storage alternative.**",
    )
    .replace(
      "  meant. Note that the leak comes from publishing entries in the clear, not from",
      [
        "  meant.",
        "",
        "  <!--",
        "- **A plain cleartext RFC 6962 log.**",
        "  -->",
        "",
        "  Note that the leak comes from publishing entries in the clear, not from",
      ].join("\n"),
    );
}

function spoofAdrItemWithFencedToken(source) {
  return source
    .replace(
      "- **A plain cleartext RFC 6962 log.**",
      "- **An unrelated storage alternative.**",
    )
    .replace(
      "  meant. Note that the leak comes from publishing entries in the clear, not from",
      [
        "  meant.",
        "",
        "  ```markdown",
        "- **A plain cleartext RFC 6962 log.**",
        "  ```",
        "",
        "  Note that the leak comes from publishing entries in the clear, not from",
      ].join("\n"),
    );
}

function insertSetextSectionBeforeClaim(source, key) {
  const bounds = claimTrioBounds(source, key);
  const paragraphStart = source.lastIndexOf("\n\n", bounds.startIndex - 1);
  assert(paragraphStart >= 0, `${key} lacks a paragraph boundary for the setext mutant`);
  return `${source.slice(0, paragraphStart + 2)}Unrelated normative section\n` +
    `---------------------------\n\n${source.slice(paragraphStart + 2)}`;
}

function insertAtxSectionBeforeClaim(source, key) {
  const bounds = claimTrioBounds(source, key);
  const paragraphStart = source.lastIndexOf("\n\n", bounds.startIndex - 1);
  assert(paragraphStart >= 0, `${key} lacks a paragraph boundary for the ATX mutant`);
  return `${source.slice(0, paragraphStart + 2)} ## Unrelated normative section\n\n` +
    source.slice(paragraphStart + 2);
}

function insertEmptyAtxSectionBeforeClaim(source, key) {
  const bounds = claimTrioBounds(source, key);
  const paragraphStart = source.lastIndexOf("\n\n", bounds.startIndex - 1);
  assert(paragraphStart >= 0, `${key} lacks a paragraph boundary for the empty ATX mutant`);
  return `${source.slice(0, paragraphStart + 2)}##\n\n${source.slice(paragraphStart + 2)}`;
}

function insertAdrContainerBlock(source, block) {
  const target = "  RFC 6962, which is why the fallback above pairs it with a VRF and a commitment.";
  assert.equal(source.split(target).length - 1, 1, "ADR container mutant target must occur once");
  return source.replace(target, `${block}\n${target}`);
}

function insertBeforeAdrCleartextItem(source, block) {
  const target = "- **A plain cleartext RFC 6962 log.**";
  assert.equal(source.split(target).length - 1, 1, "ADR pre-item mutant target must occur once");
  return source.replace(target, `${block}\n\n${target}`);
}

function insertAfterAdrCleartextItem(source, block) {
  const target = "- **A second, simpler verifier for the web client**";
  assert.equal(source.split(target).length - 1, 1, "ADR post-item mutant target must occur once");
  return source.replace(target, `${block}\n\n${target}`);
}

function insertKtVisibleOverclaim(source, overclaim) {
  const target = "What it does **not** buy is confidentiality of the entry.";
  assert.equal(source.split(target).length - 1, 1, "KT contradiction mutant target must occur once");
  return source.replace(target, `${overclaim}\n\n${target}`);
}

function insertListBoundaryBeforeClaim(source, key, marker) {
  const bounds = claimTrioBounds(source, key);
  const context = enumerationClaimContexts.get(key);
  const lineStart = source.lastIndexOf("\n", bounds.startIndex - 1) + 1;
  assert.equal(
    source.slice(lineStart, bounds.startIndex),
    context.markerIndent,
    `${key} lacks the reviewed list indentation for the list mutant`,
  );
  return `${source.slice(0, lineStart)}${marker} **Unrelated alternative.**\n\n` +
    `${context.markerIndent}${source.slice(bounds.startIndex)}`;
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
  return "| `POST` | `/kt/v1/history` | `HistoryRequest` → `DirectoryEntry<>` + `HistoryProof` + tree head + cosignatures | anyone |";
}

function expectedHistoryRequestWireClaim() {
  return [
    "`/kt/v1/history` takes this exact request:",
    "",
    "```",
    "struct {",
    "opaque label<0..255>;    /* exactly \"free2z/kt/v1/history-request\" */",
    "uint16 kt_version;       /* 0x0001 */",
    "opaque handle<1..30>;",
    "uint8  params;",
    "uint32 count;",
    "} HistoryRequest;",
    "```",
    "",
    "The parameter codes are closed:",
    "",
    "- `params = 0` means `HistoryParams::Complete`; `count` is ignored.",
    "- `params = 1` means `HistoryParams::MostRecent(count)`, and `count` MUST be",
    "greater than zero.",
    "",
    "Every other `params` value, and `params = 1` with `count = 0`, is malformed.",
    "The response proof is `akd`'s `HistoryProof`, carried opaquely under §9.4.",
  ].join("\n");
}

function expectedEnumerationKtClaim() {
  return [
    "That protection is against a bulk directory download, not against",
    "handle-by-handle reconstruction. `/kt/v1/lookup` is available to anyone (§9.2),",
    "and a public-username platform gives an observer a public list of candidate",
    "handles. Each successful lookup reveals that handle's full `DirectoryEntry`,",
    "including its device credentials and contact endpoints. Rate limiting can make",
    "enumeration slower and more expensive; it does not make membership or the",
    "returned metadata for known or guessed handles cryptographically private. The",
    "zero-knowledge benefit remains concrete: there is no one-shot corpus, and",
    "unqueried or unguessed handles remain hidden.",
  ].join("\n");
}

function expectedEnumerationAdrClaim() {
  return [
    "**Correction (2026-09-03) — “the full membership ... as a downloadable",
    "file” distinguishes bulk publication from enumeration; it does not make",
    "public handles non-enumerable.** The rejection above remains sound: a",
    "cleartext log exposes one permanent corpus that can be copied without first",
    "knowing or guessing any handle. The adopted zero-knowledge set prevents that",
    "one-shot download and keeps an entry hidden from an observer who does not",
    "query or guess its handle.",
    "",
    "It does not prevent handle-by-handle reconstruction. `/kt/v1/lookup` is",
    "available to anyone, a successful response carries the full",
    "`DirectoryEntry`, and on a public-username platform the public username list",
    "supplies candidate handles. Server rate limits can raise the time and request",
    "cost of that reconstruction, but they are an operational bound, not a",
    "cryptographic claim that membership, device count, credential and entry",
    "timestamps, or contact endpoints for queried handles are non-enumerable.",
  ].join("\n");
}

function validateClaimInventory(inventory) {
  assert.equal(inventory.size, requiredClaimInventory.size, "claim inventory row count drifted");
  for (const [key, path] of requiredClaimInventory) {
    assert.equal(inventory.get(key), path, `${key} is missing or points at the wrong documentation file`);
  }
}

function validateClaimBlocks(files, audit, inventory = claimInventory) {
  validateClaimInventory(inventory);
  const byPath = new Map(files);
  for (const [key, relativePath] of inventory) {
    assert(byPath.has(relativePath), `missing documentation file ${relativePath}`);
    const source = byPath.get(relativePath);
    if (key === "history_proof_type") {
      const expected = expectedHistoryClaim();
      assert.equal(source.split(expected).length - 1, 1, `${relativePath}: normative HistoryProof row must occur exactly once`);
      assert(!source.includes("HistoryProofV2"), `${relativePath}: invented HistoryProofV2 type remains normative`);
    } else if (key === "history_request_wire") {
      assert.equal(
        claimBlock(source, key),
        expectedHistoryRequestWireClaim(),
        `${relativePath}: ${key} claim drifted from the implemented wire contract`,
      );
    } else if (key === "audit_scope") {
      assert.equal(claimBlock(source, key), expectedAuditClaim(audit), `${relativePath}: ${key} claim drifted from executable evidence`);
    } else if (key === "enumeration_boundary_kt") {
      const expected = expectedEnumerationKtClaim();
      assert.equal(claimBlock(source, key), expected, `${relativePath}: ${key} claim drifted from the reviewed privacy boundary`);
      validateEnumerationClaimContext(source, key);
    } else if (key === "enumeration_boundary_adr") {
      const expected = expectedEnumerationAdrClaim();
      assert.equal(claimBlock(source, key), expected, `${relativePath}: ${key} claim drifted from the reviewed privacy boundary`);
      validateEnumerationClaimContext(source, key);
    } else {
      assert.fail(`unrecognized claim inventory key ${key}`);
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

  for (const key of ["audit_scope", "history_proof_type", "history_request_wire"]) {
    const relativePath = claimInventory.get(key);
    const end = key === "audit_scope" || key === "history_request_wire"
      ? `<!-- akd-claim:${key}:end -->`
      : expectedHistoryClaim();
    const mutatedFiles = files.map(([path, source]) => [
      path,
      path === relativePath
        ? source.replace(
            end,
            key === "audit_scope" || key === "history_request_wire"
              ? `MUTANT\n${end}`
              : end.replace("HistoryProof", "HistoryProofV2"),
          )
        : source,
    ]);
    assert.throws(() => validateClaimBlocks(mutatedFiles, audit), `${key} prose mutant survived`);
    killed.claims += 1;
  }

  const historyRequestMutations = [
    [
      "complete parameter case deleted",
      "- `params = 0` means `HistoryParams::Complete`; `count` is ignored.\n",
      "",
    ],
    [
      "most-recent parameter case deleted",
      "- `params = 1` means `HistoryParams::MostRecent(count)`, and `count` MUST be\n  greater than zero.\n",
      "",
    ],
    [
      "most-recent nonzero rule weakened",
      "- `params = 1` means `HistoryParams::MostRecent(count)`, and `count` MUST be\n  greater than zero.",
      "- `params = 1` means `HistoryParams::MostRecent(count)`, and `count` MAY be\n  zero or greater.",
    ],
    [
      "most-recent zero rejection removed",
      "Every other `params` value, and `params = 1` with `count = 0`, is malformed.",
      "Every other `params` value is malformed.",
    ],
  ];
  for (const [name, target, replacement] of historyRequestMutations) {
    const mutatedFiles = files.map(([path, source]) => {
      if (path !== claimInventory.get("history_request_wire")) return [path, source];
      assert.equal(source.split(target).length - 1, 1, `${name}: mutation target must occur once`);
      return [path, source.replace(target, replacement)];
    });
    assert.throws(
      () => validateClaimBlocks(mutatedFiles, audit),
      `${name} prose mutant survived`,
    );
    killed.claims += 1;
  }

  for (const tag of ['<details title=">">', '<details title="/>">', "<details title='/>' >"]) {
    const tokens = rawHtmlTagTokens(tag);
    assert.equal(tokens.length, 1, `quoted HTML tag was not tokenized as one element: ${tag}`);
    assert.equal(tokens[0].name, "details", `quoted HTML tag name drifted: ${tag}`);
    assert.equal(tokens[0].selfClosing, false, `quoted attribute text became a self-closing slash: ${tag}`);
  }
  assert.deepEqual(rawHtmlTagTokens("</ details>"), [], "spaced malformed close became an HTML end tag");

  for (const key of ["enumeration_boundary_kt", "enumeration_boundary_adr"]) {
    const relativePath = claimInventory.get(key);
    const expected = key === "enumeration_boundary_kt"
      ? expectedEnumerationKtClaim()
      : expectedEnumerationAdrClaim();
    const mutateFiles = (mutation) => files.map(([path, source]) => [
      path,
      path === relativePath ? mutation(source) : source,
    ]);
    const reject = (name, mutation) => {
      assert.throws(
        () => validateClaimBlocks(mutateFiles(mutation), audit),
        `${key} ${name} mutant survived`,
      );
      killed.claims += 1;
    };
    const rejectWith = (name, mutation, expectedError) => {
      assert.throws(
        () => validateClaimBlocks(mutateFiles(mutation), audit),
        expectedError,
        `${key} ${name} mutant failed for the wrong reason or survived`,
      );
      killed.claims += 1;
    };

    const missingInventoryRow = new Map(claimInventory);
    missingInventoryRow.delete(key);
    assert.throws(
      () => validateClaimBlocks(files, audit, missingInventoryRow),
      `${key} inventory-row deletion mutant survived`,
    );
    killed.claims += 1;

    reject("complete-deletion", (source) => removeClaimBlock(source, key));
    reject("whole-trio-relocation", (source) => relocateClaimTrio(source, key));
    reject("fenced-context", (source) => fenceClaimInPlace(source, key));
    reject("raw-html-comment-context", (source) => wrapClaimTrio(source, key, "<!--", "-->"));
    reject("collapsed-details-context", (source) => wrapClaimTrio(
      source,
      key,
      "<details><summary>Non-normative note</summary>",
      "</details>",
    ));
    reject("hidden-container-context", (source) =>
      wrapClaimTrio(source, key, '<div hidden="hidden">', "</div>"));
    reject("one-space-atx-section-boundary", (source) =>
      insertAtxSectionBeforeClaim(source, key));
    reject("empty-atx-section-boundary", (source) =>
      insertEmptyAtxSectionBeforeClaim(source, key));
    reject("textarea-raw-html-context", (source) =>
      wrapClaimTrio(source, key, "<textarea>", "</textarea>"));
    reject("address-raw-html-context", (source) =>
      wrapClaimTrio(source, key, "<address>", "</address>"));
    reject("processing-instruction-raw-html-context", (source) =>
      wrapClaimTrio(source, key, "<?f2z", "?>"));
    reject("declaration-raw-html-context", (source) =>
      wrapClaimTrio(source, key, "<!F2Z", ">"));
    reject("cdata-raw-html-context", (source) =>
      wrapClaimTrio(source, key, "<![CDATA[", "]]>"));
    reject("hidden-canonical-visible-contradiction", (source) => {
      const visibleContradiction = key === "enumeration_boundary_kt"
        ? "That protection prevents handle-by-handle reconstruction and makes membership and device metadata cryptographically non-enumerable."
        : "  The adopted zero-knowledge set prevents handle-by-handle reconstruction and makes queried membership and device metadata cryptographically non-enumerable.";
      return relocateClaimTrio(
        source,
        key,
        { opening: "<details><summary>Archived wording</summary>", closing: "</details>" },
        visibleContradiction,
      );
    });
    reject("quoted marker context", (source) =>
      source.replace(
        `<!-- akd-claim:${key}:start -->`,
        `> <!-- akd-claim:${key}:start -->`,
      ),
    );
    for (const [name, opening, closing] of [
      ["visible-span-container", "<span>", "</span>"],
      ["visible-open-details-container", "<details open>", "</details>"],
    ]) {
      const contradiction = "The zero-knowledge set prevents handle-by-handle reconstruction and makes queried membership cryptographically non-enumerable.";
      rejectWith(
        name,
        (source) => key === "enumeration_boundary_kt"
          ? insertKtVisibleOverclaim(source, `${opening}\n${contradiction}\n${closing}`)
          : insertAdrContainerBlock(
              source,
              `  ${opening}\n  ${contradiction}\n  ${closing}`,
            ),
        /contains raw HTML in its protected rendered section/,
      );
    }
    if (key === "enumeration_boundary_adr") {
      for (const [name, block] of [
        ["four-space-container-fence", "    ```markdown"],
        ["five-space-container-fence", "     ~~~markdown"],
        ["four-space-container-atx", "    ## Unrelated normative section"],
        ["five-space-container-atx", "     ## Unrelated normative section"],
        ["four-space-container-empty-atx", "    ##"],
        ["five-space-container-empty-atx", "     ##"],
        ["four-space-container-setext", "    Unrelated normative section\n    ---------------------------"],
        ["five-space-container-setext", "     Unrelated normative section\n     ---------------------------"],
      ]) {
        reject(name, (source) => insertAdrContainerBlock(source, block));
      }
      const rootMarkers = ["-", "+", "*", "1.", "1)", "2.", "2)", "123456789.", "123456789)"];
      for (const marker of rootMarkers) {
        reject(`${marker}-list-boundary`, (source) =>
          insertListBoundaryBeforeClaim(source, key, marker));
      }
      for (const marker of rootMarkers) {
        reject(`${marker}-empty-list-boundary`, (source) =>
          insertListBoundaryBeforeClaim(source, key, marker).replace(
            `${marker} **Unrelated alternative.**`,
            marker,
          ));
      }
      const nestedItems = [
        "- **Root alternative.**",
        "  - Nested unordered dash detail",
        "  + Nested unordered detail",
        "  * Nested unordered star detail",
        "  1. Nested ordered detail",
        "  1) Nested parenthesized ordered detail",
        "  123456789. Nested maximum-width ordered detail",
        "  123456789) Nested maximum-width parenthesized detail",
        "* **Sibling alternative.**",
      ].join("\n");
      assert.deepEqual(
        markdownListItemStarts(nestedItems).map(({ marker, text }) => ({ marker, text })),
        [
          { marker: "-", text: "- **Root alternative.**" },
          { marker: "*", text: "* **Sibling alternative.**" },
        ],
        "nested list items were mistaken for top-level alternative boundaries",
      );
      reject("prevention-inversion", (source) => {
        const mutated = expected.replace("does not prevent", "prevents");
        assert.notEqual(mutated, expected, `${key} lacks the reconstruction-refusal boundary`);
        return replaceClaimBlock(source, key, mutated);
      });
      reject("standalone-visible-contradiction", (source) => insertAdrContainerBlock(
        source,
        "  The ZKS stops handle-by-handle reconstruction and makes public membership non-enumerable.",
      ));
      for (const [name, overclaim] of [
        [
          "pre-item-standalone-visible-contradiction",
          "The ZKS blocks enumeration of public handles and keeps queried device metadata cryptographically private.",
        ],
        [
          "pre-item-root-bullet-visible-contradiction",
          "- The directory guarantees known-user membership confidentiality.",
        ],
        [
          "pre-item-table-visible-contradiction",
          "| Scope | Guarantee |\n|---|---|\n| Public-handle membership | non-enumerable |",
        ],
        [
          "pre-item-mixed-html-visible-contradiction",
          "<hr> The ZKS blocks enumeration of public handles and keeps queried device metadata cryptographically private.",
        ],
        [
          "pre-item-mixed-html-root-bullet-visible-contradiction",
          "- <hr> The directory guarantees known-user membership confidentiality.",
        ],
        [
          "pre-item-mixed-html-table-visible-contradiction",
          "| Scope | Guarantee |\n|---|---|\n| Public-handle membership | <hr> non-enumerable |",
        ],
      ]) {
        const expectedError = name.includes("mixed-html")
          ? /contains raw HTML in its protected rendered section/
          : name === "pre-item-root-bullet-visible-contradiction"
            ? /visible surrounding prose changed/
            : /visible enumeration-privacy overclaim/;
        rejectWith(name, (source) => insertBeforeAdrCleartextItem(source, overclaim), expectedError);
      }
      rejectWith(
        "pre-item-open-vocabulary-visible-contradiction",
        (source) => insertBeforeAdrCleartextItem(
          source,
          "The adopted directory ensures an attacker cannot learn the user roster one name at a time.",
        ),
        /visible surrounding prose changed/,
      );
      rejectWith(
        "post-item-visible-contradiction",
        (source) => insertAfterAdrCleartextItem(
          source,
          "The ZKS blocks enumeration of public handles and keeps queried device metadata cryptographically private.",
        ),
        /visible enumeration-privacy overclaim/,
      );
    } else {
      reject("quoted-greater-than-details-context", (source) => wrapClaimTrio(
        source,
        key,
        '<details title="/>">',
        "</details>",
      ));
      reject("malformed-spaced-close-details-context", (source) => wrapClaimTrio(
        source,
        key,
        "<details>\n</ details>",
        "</details>",
      ));
      for (const [name, overclaim] of [
        [
          "standalone-visible-contradiction",
          "The zero-knowledge set prevents handle-by-handle reconstruction and makes\nqueried membership and device metadata cryptographically non-enumerable.",
        ],
        ["bullet-visible-contradiction", "- ZKS blocks enumeration of public handles."],
        [
          "table-visible-contradiction",
          "| Scope | Guarantee |\n|---|---|\n| Queried device metadata | cryptographically concealed |",
        ],
        [
          "synonym-visible-contradiction",
          "AKD thwarts per-handle discovery and keeps contact endpoints secret for known users.",
        ],
        [
          "rate-limit-visible-contradiction",
          "Rate limiting guarantees privacy for known-handle membership.",
        ],
        [
          "open-vocabulary-visible-contradiction",
          "The adopted directory ensures an attacker cannot learn the user roster one name at a time.",
        ],
        [
          "mixed-html-standalone-visible-contradiction",
          "<hr> The ZKS blocks enumeration of public handles and keeps queried device metadata cryptographically private.",
        ],
        [
          "mixed-html-bullet-visible-contradiction",
          "- <hr> ZKS blocks enumeration of public handles.",
        ],
        [
          "mixed-html-table-visible-contradiction",
          "| Scope | Guarantee |\n|---|---|\n| Queried device metadata | <hr> cryptographically concealed |",
        ],
      ]) {
        if (name.includes("mixed-html")) {
          rejectWith(
            name,
            (source) => insertKtVisibleOverclaim(source, overclaim),
            /contains raw HTML in its protected rendered section/,
          );
        } else {
          reject(name, (source) => insertKtVisibleOverclaim(source, overclaim));
        }
      }
      rejectWith(
        "mixed-html-suffix-visible-contradiction",
        (source) => insertKtVisibleOverclaim(
          source,
          "The ZKS blocks enumeration of public handles and keeps queried device metadata cryptographically private. <hr>",
        ),
        /contains raw HTML in its protected rendered section/,
      );
    }
    reject("rate-limit-cryptographic-guarantee", (source) => {
      const rateBoundary = key === "enumeration_boundary_kt"
        ? "Rate limiting can make\nenumeration slower and more expensive; it does not make membership or the\nreturned metadata for known or guessed handles cryptographically private."
        : "Server rate limits can raise the time and request\ncost of that reconstruction, but they are an operational bound, not a\ncryptographic claim that membership, device count, credential and entry\ntimestamps, or contact endpoints for queried handles are non-enumerable.";
      const mutated = expected.replace(rateBoundary, "Rate limiting is a cryptographic guarantee.");
      assert.notEqual(mutated, expected, `${key} lacks the operational rate-limit boundary`);
      return replaceClaimBlock(source, key, mutated);
    });
    reject("queried-entry-unqueried-label-collapse", (source) => {
      const lookup = key === "enumeration_boundary_kt"
        ? "handle-by-handle reconstruction. `/kt/v1/lookup` is available to anyone (§9.2),\nand a public-username platform gives an observer a public list of candidate\nhandles. Each successful lookup reveals that handle's full `DirectoryEntry`,\nincluding its device credentials and contact endpoints."
        : "It does not prevent handle-by-handle reconstruction. `/kt/v1/lookup` is\navailable to anyone, a successful response carries the full\n`DirectoryEntry`, and on a public-username platform the public username list\nsupplies candidate handles.";
      const hidden = key === "enumeration_boundary_kt"
        ? "unqueried or unguessed handles remain hidden."
        : "keeps an entry hidden from an observer who does not\nquery or guess its handle.";
      const replacement = key === "enumeration_boundary_kt"
        ? "Per-handle lookup details are omitted."
        : "Per-handle lookup details are omitted.";
      let mutated = expected.replace(lookup, replacement);
      assert.notEqual(mutated, expected, `${key} lacks the full-entry disclosure boundary`);
      const withoutHidden = mutated.replace(hidden, "Unqueried-label privacy is omitted.");
      assert.notEqual(withoutHidden, mutated, `${key} lacks the unqueried-label privacy boundary`);
      return replaceClaimBlock(source, key, withoutHidden);
    });
  }

  const hiddenOverclaim = "The zero-knowledge set prevents handle-by-handle reconstruction and makes queried membership cryptographically non-enumerable.";
  const ktPath = claimInventory.get("enumeration_boundary_kt");
  const hiddenOverclaimFiles = (wrapper) => files.map(([path, source]) => [
    path,
    path === ktPath
      ? insertKtVisibleOverclaim(source, wrapper(hiddenOverclaim))
      : source,
  ]);
  for (const [name, wrapper] of [
    ["comment", (text) => `<!-- ${text} -->`],
    ["fence", (text) => `\`\`\`markdown\n${text}\n\`\`\``],
  ]) {
    assert.doesNotThrow(
      () => validateClaimBlocks(hiddenOverclaimFiles(wrapper), audit),
      `${name}-hidden overclaim was mistaken for rendered normative prose`,
    );
  }

  const coordinatedEnumerationMutation = (mutation) => files.map(([path, source]) => {
    for (const key of ["enumeration_boundary_kt", "enumeration_boundary_adr"]) {
      if (path === claimInventory.get(key)) return [path, mutation(source, key)];
    }
    return [path, source];
  });
  assert.throws(
    () => validateClaimBlocks(
      coordinatedEnumerationMutation(hideClaimTrioBehindMalformedFence),
      audit,
    ),
    "simultaneous malformed-fence hiding and visible-contradiction mutant survived",
  );
  killed.claims += 1;
  assert.throws(
    () => validateClaimBlocks(
      coordinatedEnumerationMutation(spoofClaimStructureWithHiddenTokens),
      audit,
    ),
    "simultaneous hidden-heading and hidden-list-boundary mutant survived",
  );
  killed.claims += 1;
  assert.throws(
    () => validateClaimBlocks(
      coordinatedEnumerationMutation(insertSetextSectionBeforeClaim),
      audit,
    ),
    "simultaneous setext section-boundary mutant survived",
  );
  killed.claims += 1;
  const fencedItemFiles = files.map(([path, source]) => [
    path,
    path === claimInventory.get("enumeration_boundary_adr")
      ? spoofAdrItemWithFencedToken(source)
      : source,
  ]);
  assert.throws(
    () => validateClaimBlocks(fencedItemFiles, audit),
    "fenced fake cleartext-log item boundary mutant survived",
  );
  killed.claims += 1;

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
