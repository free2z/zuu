#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildReleaseBumpContents,
  releaseBumpRelativePaths,
} from "./release-bump-content.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDirectory, "../../..");
const statusPath = "wallet/zuuli/STATUS.md";
const releasingPath = "wallet/zuuli/docs/releasing.md";
// Seal the complete reviewed source surfaces so unknown prose cannot create an
// exception beside otherwise canonical sections. STATUS has exactly one
// enumerated dynamic field: the canonical audit SHA/date marker replaced below
// before hashing. The semantic section/table checks remain independent so a
// reviewer gets a precise diagnostic rather than an opaque digest alone.
const RELEASING_DOCUMENT_SHA256 =
  "943027c8f04b49397959e60c97ed0ae432bbfdff6a48ac7bb2b2ac437daf017d";
const STATUS_DOCUMENT_SHA256 =
  "2de8c62c277de3924de5a7500b2afc48f257caf5b5abd4cab60353a2ce4fd4bb";
const statusSourceMarkerPattern =
  /^Last re-derived from `origin\/main` at\n`[0-9a-f]{40}` on \d{4}-\d{2}-\d{2}\. Before a release,\nupdate the evidence and disposition for every non-ready row; do not carry this\ncommit or date forward mechanically\.$/gm;
const canonicalStatusSourceMarker = "<STATUS_SOURCE_MARKER>";

const releasingPolicyRequirements = [
  "Every new or materially changed step in `.github/workflows/zuuli-release.yml` must be backed before its implementation PR merges by at least one of these reviewable dispositions:",
  "successful execution through a non-publishing dry-run path that reaches the step without weakening its normal failure policy;",
  "a mutation-sensitive fixture or checker that exercises the step's pure computation and is proven to reject a deliberately corrupted input;",
  "an explicit entry in [`../STATUS.md`](../STATUS.md) naming the untested path, why it cannot safely execute before release, and the decision to ship or defer the affected target.",
];
const canonicalReleasingPolicySection = `
Every new or materially changed step in \`.github/workflows/zuuli-release.yml\`
must be backed before its implementation PR merges by at least one of these
reviewable dispositions:

1. successful execution through a non-publishing dry-run path that reaches the
   step without weakening its normal failure policy;
2. a mutation-sensitive fixture or checker that exercises the step's pure
   computation and is proven to reject a deliberately corrupted input; or
3. an explicit entry in [\`../STATUS.md\`](../STATUS.md) naming the untested path,
   why it cannot safely execute before release, and the decision to ship or
   defer the affected target.

A credential-free packaging smoke proves only the equivalent package-building
and inspection logic it actually runs. It is not proof that a protected
credential-bearing job, external signing/notarization service, cleanup path, or
store transaction ran. Cross-compilation likewise proves compilation, not
target-native execution. Record those boundaries without upgrading fixture or
packaging evidence into protected-release evidence.

Workflow run links record job conclusions, but uploaded evidence is deliberately
retention-bounded rather than permanent: credential handoffs expire after 1 day,
packaging artifacts after 14 days, and protected finalizer and release-index
artifacts after 90 days. Record artifact identities and retention limits without
describing these expiring uploads as durable archives.
`;
const releaseEvidenceInventory = new Map([
  ["`android-protected-sign-upload`", {
    path: "Android signed payload comparison, `signed_abis`, `signing-record.json`, `CHECKSUMS`, and Play upload",
    evidenceClass: "`protected-executed`",
    distribution: "`mobile-shipped`",
    execution: "`Android / protected sign and Play upload` succeeded for [build 17](https://github.com/free2z/zuu/actions/runs/33330274664/job/99310600158), [18](https://github.com/free2z/zuu/actions/runs/33355762719/job/99382950495), [19](https://github.com/free2z/zuu/actions/runs/33369623712/job/99427020050), and [20](https://github.com/free2z/zuu/actions/runs/33494458918/job/99819565832). In each job, `Materialize, sign, verify, optionally upload, and destroy credentials` succeeded, followed by a successful three-file signed-artifact handoff. Build 20's [read-only store audit](https://github.com/free2z/zuu/actions/runs/33496770265) independently found the exact Play build 20 release present and deleted its audit edit without committing it.",
    boundary: "`aab-payload-digest.node-test.mjs` exercises a real `jarsigner` fixture and rejects payload mutation and ordering drift. `apple-credential-boundary.node-test.mjs` rejects removal of the digest comparison, signed-output records, upload transaction, or fail-closed step behavior.",
  }],
  ["`android-credential-cleanup`", {
    path: "Android credential and signed-output destruction",
    evidenceClass: "`protected-executed`",
    distribution: "`mobile-shipped`",
    execution: "Both `Destroy ephemeral Android credentials` and `Destroy signed Android output` succeeded in each of the four signer jobs above. Artifact upload occurred between them, so the success-path order itself executed.",
    boundary: "`apple-credential-boundary.node-test.mjs` rejects skipped or soft-failed credential cleanup and wrong cleanup/upload order. No secret values are retained as evidence.",
  }],
  ["`android-finalization`", {
    path: "Android credential-free finalization",
    evidenceClass: "`protected-executed`",
    distribution: "`mobile-shipped`",
    execution: "`Android / credential-free shipped-artifact provenance` succeeded for [build 17](https://github.com/free2z/zuu/actions/runs/33330274664/job/99310771734), [18](https://github.com/free2z/zuu/actions/runs/33355762719/job/99383153475), [19](https://github.com/free2z/zuu/actions/runs/33369623712/job/99427364135), and [20](https://github.com/free2z/zuu/actions/runs/33494458918/job/99819938900), including signed-AAB verification, unpacking, Syft, inventory binding, checksums/provenance, attestation, and artifact upload.",
    boundary: "`apple-credential-boundary.node-test.mjs` locks the complete finalizer and rejects weakened verification or ordering; the canonical-payload fixtures reject altered, undeclared, escaping, and symlinked members.",
  }],
  ["`release-index`", {
    path: "Immutable release index",
    evidenceClass: "`protected-executed`",
    distribution: "`mobile-shipped`",
    execution: "`Immutable GitHub release index` succeeded for [build 17](https://github.com/free2z/zuu/actions/runs/33330274664/job/99310819089), [18](https://github.com/free2z/zuu/actions/runs/33355762719/job/99417503165), [19](https://github.com/free2z/zuu/actions/runs/33369623712/job/99442471138), and [20](https://github.com/free2z/zuu/actions/runs/33494458918/job/99820072758); source-binding verification and index artifact upload both ran.",
    boundary: "`release-tag-identity.node-test.mjs` accepts a complete source-bound index fixture and rejects wrong source, duplicate/missing provenance, recursive prior indexes, malformed identity, and invalid roots. `apple-credential-boundary.node-test.mjs` rejects missing Android finalizer/index dependencies.",
  }],
  ["`linux-packaging`", {
    path: "Linux audit instrumentation, artifact SBOMs/bindings, and labeled source inventory",
    evidenceClass: "`packaging-executed`",
    distribution: "`desktop-deferred`",
    execution: "Build 20's credential-free [Linux packaging job](https://github.com/free2z/zuu/actions/runs/33494458922/job/99813293131) succeeded through pinned Cargo audit instrumentation, real-package inspector fixtures, AppImage/deb/rpm scans, bindings, the labeled source inventory, checksums/provenance, and upload.",
    boundary: "`artifact-sbom.node-test.mjs` uses real AppImage/deb/rpm canaries and rejects missing instrumentation, decorative or source-substituted artifact scans, early manifests, and altered bindings. The protected Linux release job remains unexecuted because releases are mobile-only.",
  }],
  ["`macos-packaging`", {
    path: "macOS artifact SBOMs/bindings, labeled source inventory, and Keychain entitlement policy",
    evidenceClass: "`packaging-executed-protected-unexecuted`",
    distribution: "`desktop-deferred`",
    execution: "Build 20's credential-free [macOS packaging job](https://github.com/free2z/zuu/actions/runs/33494458922/job/99813293260) succeeded through the Keychain/capture source policy, real package collection, DMG/ZIP scans, bindings, labeled source inventory, checksums/provenance, and upload.",
    boundary: "`artifact-sbom.node-test.mjs` uses real ZIP and `hdiutil` DMG canaries. `macos-keychain-entitlements.node-test.mjs` rejects missing or altered app/team/keychain groups and capture entitlements. Protected macOS system signing, notarization, and credential cleanup remain deliberately unexecuted while desktop shipping is deferred.",
  }],
]);
const allowedEvidenceClasses = new Set([
  "`protected-executed`",
  "`packaging-executed`",
  "`packaging-executed-protected-unexecuted`",
]);
const allowedDistributions = new Set(["`mobile-shipped`", "`desktop-deferred`"]);
const releaseEvidencePrelude = `
ZUULI currently ships mobile internal builds only; desktop distribution is
deferred and is not currently shipped. Protected release builds 17 through 20
all selected the \`mobile\` target. Their Linux package and three macOS jobs were
therefore skipped, including macOS system signing, notarization, and credential
cleanup. A credential-free packaging smoke is not evidence that those protected
desktop jobs ran.

The six release paths audited by [#754](https://github.com/free2z/zuu/issues/754)
have the following run-linked evidence and retention-bounded artifacts. Credential
handoffs expire after 1 day, packaging artifacts after 14 days, and protected
finalizer and release-index artifacts after 90 days; these links are evidence of
execution, not a permanent artifact archive.
`;

function normalizedProse(contents) {
  return contents.replace(/\s+/g, " ").trim();
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function canonicalStatusDocument(contents) {
  const matches = [...contents.matchAll(statusSourceMarkerPattern)];
  if (matches.length !== 1) {
    throw new Error(
      `STATUS.md must contain exactly one canonical re-derivation source marker, found ${matches.length}`,
    );
  }
  return contents.replace(statusSourceMarkerPattern, canonicalStatusSourceMarker);
}

// CommonMark 0.31.2 §4.6 type-6 block tags. Type 1 (script/pre/style/textarea)
// and the other raw block forms are handled separately below.
const commonMarkHtmlBlockTags = [
  "address", "article", "aside", "base", "basefont", "blockquote", "body",
  "caption", "center", "col", "colgroup", "dd", "details", "dialog", "dir",
  "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
  "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head",
  "header", "hr", "html", "iframe", "legend", "li", "link", "main", "menu",
  "menuitem", "nav", "noframes", "ol", "optgroup", "option", "p", "param",
  "search", "section", "summary", "table", "tbody", "td", "tfoot", "th",
  "thead", "title", "tr", "track", "ul",
];
const commonMarkHtmlBlockTagPattern = new RegExp(
  `^ {0,3}<\\/?(?:${commonMarkHtmlBlockTags.join("|")})(?:[ \\t]|\\/?>(?:[ \\t]*)$|$)`,
  "i",
);
const commonMarkGenericHtmlBlockPattern = /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^<>]*?)?\s*\/?>\s*$/;
const htmlVoidElements = new Set([
  "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame",
  "hr", "img", "input", "keygen", "link", "meta", "param", "source",
  "track", "wbr",
]);

// Tokenize HTML tags the way a browser does for the subset relevant to raw
// CommonMark blocks. In particular, `>` and `/>` inside quoted attributes do
// not end a tag, and a self-closing slash does not close a non-void HTML
// element such as <details>.
function rawHtmlTags(text) {
  const indentation = /^( {0,3})</.exec(text);
  if (!indentation) return { tags: [], valid: true };
  const tags = [];
  let cursor = indentation[1].length;
  while (cursor < text.length) {
    const start = text.indexOf("<", cursor);
    if (start < 0) break;
    let index = start + 1;
    let closing = false;
    if (text[index] === "/") {
      closing = true;
      index += 1;
      if (/\s/.test(text[index] ?? "")) return { tags, valid: false };
    }
    const nameMatch = /^[A-Za-z][A-Za-z0-9-]*/.exec(text.slice(index));
    if (!nameMatch) {
      cursor = start + 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    index += nameMatch[0].length;
    if (!/[\s/>]/.test(text[index] ?? "")) return { tags, valid: false };
    let quote = null;
    let end = -1;
    for (; index < text.length; index += 1) {
      const character = text[index];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        end = index;
        break;
      } else if (character === "<") {
        return { tags, valid: false };
      }
    }
    if (end < 0 || quote) return { tags, valid: false };
    const inside = text.slice(start + 1, end);
    if (closing && !new RegExp(`^/${name}[ \\t]*$`, "i").test(inside)) {
      return { tags, valid: false };
    }
    tags.push({ name, closing, void: htmlVoidElements.has(name) });
    cursor = end + 1;
  }
  return { tags, valid: true };
}

function updateHtmlStack(stack, tokenized) {
  if (!tokenized.valid) return false;
  for (const tag of tokenized.tags) {
    if (tag.closing) {
      if (stack.at(-1) !== tag.name) return false;
      stack.pop();
    } else if (!tag.void) {
      stack.push(tag.name);
    }
  }
  return true;
}

function stripHtmlComments(text, state) {
  let rendered = "";
  for (let index = 0; index < text.length;) {
    if (state.inComment) {
      const end = text.indexOf("-->", index);
      if (end < 0) break;
      state.inComment = false;
      index = end + 3;
    } else {
      const start = text.indexOf("<!--", index);
      if (start < 0) {
        rendered += text.slice(index);
        break;
      }
      rendered += text.slice(index, start);
      state.inComment = true;
      index = start + 4;
    }
  }
  return rendered;
}

function atxH2(text) {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/.exec(text);
  if (!match || match[1].length !== 2) return null;
  const title = (match[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
  return title.length === 0 ? "##" : `## ${title}`;
}

function markdownTopLevel(contents) {
  const headings = [];
  const visibleLines = [];
  const lines = contents.match(/[^\n]*(?:\n|$)/g) ?? [];
  const commentState = { inComment: false };
  let offset = 0;
  let fence = null;
  let rawBlock = null;
  let previousVisible = null;
  const htmlStack = [];
  let validHtml = true;

  for (const rawLine of lines) {
    const text = rawLine.endsWith("\n") ? rawLine.slice(0, -1) : rawLine;
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`);
      if (closing.test(text)) fence = null;
      offset += rawLine.length;
      continue;
    }
    if (rawBlock?.kind === "delimiter") {
      const ends = rawBlock.kind === "blank"
        ? text.trim().length === 0
        : rawBlock.end.test(text);
      if (ends) rawBlock = null;
      offset += rawLine.length;
      previousVisible = null;
      continue;
    }

    const rendered = stripHtmlComments(text, commentState);
    if (commentState.inComment && rendered.trim().length === 0) {
      offset += rawLine.length;
      previousVisible = null;
      continue;
    }

    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(rendered);
    if (fenceMatch && !(fenceMatch[1][0] === "`" && fenceMatch[2].includes("`"))) {
      fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
      offset += rawLine.length;
      previousVisible = null;
      continue;
    }

    const tokenizedHtml = rawHtmlTags(rendered);
    if (!tokenizedHtml.valid) validHtml = false;
    const wasInHtmlContainer = htmlStack.length > 0;
    if (tokenizedHtml.tags.length > 0) {
      validHtml = updateHtmlStack(htmlStack, tokenizedHtml) && validHtml;
    }
    if (rawBlock?.kind === "blank") {
      if (text.trim().length === 0) rawBlock = null;
      offset += rawLine.length;
      previousVisible = null;
      continue;
    }
    if (wasInHtmlContainer || htmlStack.length > 0 || tokenizedHtml.tags.some((tag) => tag.closing)) {
      offset += rawLine.length;
      previousVisible = null;
      continue;
    }

    const typeOne = /^ {0,3}<(script|pre|style|textarea)(?:[ \t]|>|$)/i.exec(rendered);
    let startedRawBlock = false;
    if (typeOne) {
      const end = new RegExp(`</${typeOne[1]}\\s*>`, "i");
      if (!end.test(rendered.slice(typeOne[0].length))) rawBlock = { kind: "delimiter", end };
      startedRawBlock = true;
    } else if (/^ {0,3}<\?/.test(rendered)) {
      if (!/\?>/.test(rendered)) rawBlock = { kind: "delimiter", end: /\?>/ };
      startedRawBlock = true;
    } else if (/^ {0,3}<!\[CDATA\[/.test(rendered)) {
      if (!/\]\]>/.test(rendered)) rawBlock = { kind: "delimiter", end: /\]\]>/ };
      startedRawBlock = true;
    } else if (/^ {0,3}<![A-Z]/.test(rendered)) {
      if (!/>/.test(rendered)) rawBlock = { kind: "delimiter", end: />/ };
      startedRawBlock = true;
    } else if (commonMarkHtmlBlockTagPattern.test(rendered) || commonMarkGenericHtmlBlockPattern.test(rendered)) {
      rawBlock = { kind: "blank" };
      startedRawBlock = true;
    }
    if (startedRawBlock) {
      offset += rawLine.length;
      previousVisible = null;
      continue;
    }

    visibleLines.push(rendered);
    const atx = atxH2(rendered);
    if (atx) {
      headings.push({ heading: atx, start: offset, bodyStart: offset + rawLine.length });
    } else {
      const setext = /^ {0,3}(-+)[ \t]*$/.exec(rendered);
      if (setext && previousVisible && previousVisible.text.trim().length > 0) {
        headings.push({
          heading: `## ${previousVisible.text.trim()}`,
          start: previousVisible.offset,
          bodyStart: offset + rawLine.length,
        });
      }
    }
    previousVisible = rendered.trim().length === 0
      ? null
      : { text: rendered, offset };
    offset += rawLine.length;
  }
  if (htmlStack.length > 0) validHtml = false;
  return { headings, visibleText: visibleLines.join("\n"), validHtml };
}

function markdownSection(
  contents,
  heading,
  { ordinal, previous = null, next = null },
) {
  const rawOccurrences = contents
    .split("\n")
    .filter((line) => line === heading).length;
  const { headings, validHtml } = markdownTopLevel(contents);
  if (!validHtml) {
    throw new Error("document contains malformed or unclosed raw HTML structure");
  }
  const matches = headings.filter((entry) => entry.heading === heading);
  if (rawOccurrences !== 1 || matches.length !== 1) {
    throw new Error(
      `${heading} must occur exactly once as a rendered top-level heading, found ${matches.length} rendered and ${rawOccurrences} raw`,
    );
  }
  const entry = matches[0];
  const actualOrdinal = headings.indexOf(entry);
  if (
    actualOrdinal !== ordinal ||
    (previous !== null && headings[actualOrdinal - 1]?.heading !== previous) ||
    (next !== null && headings[actualOrdinal + 1]?.heading !== next)
  ) {
    throw new Error(`${heading} is not at its reviewed top-level section ordinal`);
  }
  const nextStart = headings[actualOrdinal + 1]?.start;
  const end = nextStart === undefined
    ? contents.length
    : nextStart > 0 && contents[nextStart - 1] === "\n"
      ? nextStart - 1
      : nextStart;
  return contents.slice(entry.bodyStart, end);
}

function tableCells(line) {
  if (!line.startsWith("|") || !line.endsWith("|")) return null;
  return line.slice(1, -1).split("|").map((cell) => cell.trim());
}

function markdownLinks(contents) {
  return [...contents.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)].map(
    ([, label, url]) => ({ label, url }),
  );
}

function canonicalActionLink(link) {
  let url;
  try {
    url = new URL(link.url);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return false;
  }
  const jobPath = /^\/free2z\/zuu\/actions\/runs\/[1-9][0-9]*\/job\/[1-9][0-9]*$/;
  const auditPath = /^\/free2z\/zuu\/actions\/runs\/[1-9][0-9]*$/;
  return jobPath.test(url.pathname) ||
    (link.label === "read-only store audit" && auditPath.test(url.pathname));
}

export function verifyReleaseEvidencePolicy({
  releasingContents,
  statusContents,
}) {
  const failures = [];
  const visibleStatus = markdownTopLevel(statusContents).visibleText;
  if (sha256(releasingContents) !== RELEASING_DOCUMENT_SHA256) {
    failures.push(
      "releasing.md differs from the exact reviewed release-policy document surface",
    );
  }
  try {
    if (sha256(canonicalStatusDocument(statusContents)) !== STATUS_DOCUMENT_SHA256) {
      failures.push(
        "STATUS.md differs from the exact reviewed status and release-evidence document surface",
      );
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  let releasingSection = "";
  let statusSection = "";
  try {
    releasingSection = markdownSection(
      releasingContents,
      "## Pre-merge execution evidence for release steps",
      {
        ordinal: 0,
        next: "## SBOM scope and artifact binding",
      },
    );
    statusSection = markdownSection(
      statusContents,
      "## Release-path execution disposition",
      {
        ordinal: 1,
        previous: "## Evidence boundaries",
        next: "## Source-and-runtime-backed matrix",
      },
    );
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  const normalizedReleasing = normalizedProse(releasingSection);
  if (releasingSection !== canonicalReleasingPolicySection) {
    failures.push(
      "releasing.md pre-merge evidence section must exactly match the reviewed mandatory policy and retention boundary",
    );
  }
  for (const fragment of releasingPolicyRequirements) {
    const occurrences = normalizedReleasing.split(fragment).length - 1;
    if (occurrences !== 1) {
      failures.push(
        `releasing.md must contain exactly one ${JSON.stringify(fragment)} policy statement, found ${occurrences}`,
      );
    }
  }
  const evidenceTableHeaders = visibleStatus
    .split("\n")
    .map(tableCells)
    .filter((cells) => cells?.[0] === "Evidence ID");
  if (evidenceTableHeaders.length !== 1) {
    failures.push(
      `STATUS.md must contain exactly one rendered release evidence inventory table, found ${evidenceTableHeaders.length}`,
    );
  }

  const statusLines = statusSection.trimEnd().split("\n");
  const tableStart = statusLines.findIndex((line) => line.startsWith("|"));
  if (tableStart < 0) {
    failures.push("STATUS.md release evidence inventory table is missing");
  } else {
    const prelude = statusLines.slice(0, tableStart).join("\n");
    if (prelude.trim() !== releaseEvidencePrelude.trim()) {
      failures.push("STATUS.md release evidence disposition prose must match the reviewed shipping and retention boundary");
    }
    const tableLines = statusLines.slice(tableStart);
    if (tableLines.some((line) => !line.startsWith("|"))) {
      failures.push("STATUS.md release evidence section must contain no advisory prose after its inventory table begins");
    }
    const rows = tableLines.map(tableCells);
    const header = rows[0] ?? [];
    if (JSON.stringify(header) !== JSON.stringify([
      "Evidence ID",
      "Release path",
      "Evidence class",
      "Distribution",
      "Exact execution evidence",
      "Fixture/checker evidence and remaining boundary",
    ])) {
      failures.push("STATUS.md release evidence inventory header is not canonical");
    }
    if (!rows[1]?.every((cell) => cell === "---") || rows[1]?.length !== 6) {
      failures.push("STATUS.md release evidence inventory separator is malformed");
    }
    const evidenceRows = rows.slice(2);
    if (evidenceRows.length !== releaseEvidenceInventory.size) {
      failures.push(
        `STATUS.md release evidence inventory must contain exactly ${releaseEvidenceInventory.size} rows, found ${evidenceRows.length}`,
      );
    }
    const seen = new Set();
    for (const row of evidenceRows) {
      if (!row || row.length !== 6 || row.some((cell) => cell.length === 0)) {
        failures.push("STATUS.md release evidence inventory contains a malformed or empty row");
        continue;
      }
      const [id, path, evidenceClass, distribution, execution, boundary] = row;
      const expected = releaseEvidenceInventory.get(id);
      if (!expected) {
        failures.push(`STATUS.md release evidence inventory contains unknown ID ${JSON.stringify(id)}`);
      } else {
        if (path !== expected.path) {
          failures.push(`STATUS.md release evidence inventory has wrong release path for ${id}`);
        }
        if (!allowedEvidenceClasses.has(evidenceClass) || evidenceClass !== expected.evidenceClass) {
          failures.push(`STATUS.md release evidence inventory has wrong evidence class for ${id}`);
        }
        if (!allowedDistributions.has(distribution) || distribution !== expected.distribution) {
          failures.push(`STATUS.md release evidence inventory has wrong distribution for ${id}`);
        }
        if (execution !== expected.execution) {
          failures.push(`STATUS.md release evidence inventory execution cell for ${id} is not canonical`);
        }
        if (boundary !== expected.boundary) {
          failures.push(`STATUS.md release evidence inventory boundary cell for ${id} is not canonical`);
        }
        const links = markdownLinks(execution);
        const expectedLinks = markdownLinks(expected.execution);
        if (
          JSON.stringify(links) !== JSON.stringify(expectedLinks) ||
          links.some((link) => !canonicalActionLink(link))
        ) {
          failures.push(
            `STATUS.md release evidence inventory execution links for ${id} must be the canonical free2z/zuu Actions run/job evidence`,
          );
        }
      }
      if (seen.has(id)) failures.push(`STATUS.md release evidence inventory duplicates ${id}`);
      seen.add(id);
    }
    for (const id of releaseEvidenceInventory.keys()) {
      if (!seen.has(id)) failures.push(`STATUS.md release evidence inventory is missing ${id}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `release-step evidence policy is incomplete:\n${failures.join("\n")}`,
    );
  }
}

// This is the release-impacting surface selected by the required ZUULI gate.
// A change here can invalidate a source-backed STATUS.md disposition even when
// it does not live in the application directory itself.
const releaseImpactingPrefixes = [
  "wallet/zuuli/",
  "wallet/plugins/",
  ".github/containers/zuuli-linux/",
  ".github/actions/zuuli-rust-cache/",
];
const releaseImpactingPaths = new Set([
  "wallet/rust-toolchain.toml",
  "wallet/deny.toml",
  "scripts/check-github-actions-pins.mjs",
  "scripts/check-rust-fmt.sh",
  "scripts/check-rust-deny.sh",
  "scripts/check-rust-clippy.sh",
  "scripts/check-tauri-plugin-permissions.mjs",
  "scripts/check-zuuli-linux-image.mjs",
  "z/zcash/librustzcash",
  ".gitmodules",
  ".github/workflows/zuuli.yml",
  ".github/workflows/zuuli-linux-image.yml",
  ".github/workflows/zuuli-packaging.yml",
  ".github/workflows/zuuli-release.yml",
  ".github/workflows/zuuli-store-audit.yml",
  ".github/workflows/zuuli-store-publish.yml",
  ".github/workflows/zuuli-testflight-bootstrap.yml",
  ".github/workflows/zuuli-testflight-recovery.yml",
  ".github/workflows/cache-cleanup.yml",
  "docs/ZUULI-LINUX-BUILD-IMAGE.md",
]);

// release-bump.mjs owns exactly these generated identity surfaces. The source
// commit is still checked by release-identity.mjs, which proves that their
// version/build values agree with canonical release.json.
export const releaseBumpPaths = new Set(
  releaseBumpRelativePaths.map((path) => `wallet/zuuli/${path}`),
);

export function isReleaseImpactingPath(path) {
  return (
    releaseImpactingPaths.has(path) ||
    releaseImpactingPrefixes.some((prefix) => path.startsWith(prefix)) ||
    path.startsWith("z/zcash/librustzcash/")
  );
}

function validCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function parseStatusMarker(contents) {
  const label = "Last re-derived from `origin/main` at";
  const occurrences = contents.split(label).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `STATUS.md must contain exactly one ${JSON.stringify(label)} marker, found ${occurrences}`,
    );
  }

  const marker =
    /^Last re-derived from `origin\/main` at\n`([0-9a-f]{40})` on (\d{4}-\d{2}-\d{2})\./m.exec(
      contents,
    );
  if (!marker) {
    throw new Error(
      "STATUS.md re-derivation marker must contain a full lowercase 40-character commit SHA and YYYY-MM-DD date",
    );
  }
  if (!validCalendarDate(marker[2])) {
    throw new Error(
      `STATUS.md re-derivation date is not a real calendar date: ${marker[2]}`,
    );
  }
  return { auditSha: marker[1], auditDate: marker[2] };
}

function git(repoRoot, args, options = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio,
  });
}

function requireCommit(repoRoot, sha, label) {
  try {
    git(repoRoot, ["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
  } catch {
    throw new Error(`${label} is not an available commit: ${sha}`);
  }
}

function changedPaths(repoRoot, from, to) {
  const bytes = git(
    repoRoot,
    ["diff", "--name-only", "--no-renames", "-z", from, to, "--"],
    { encoding: "buffer" },
  );
  return bytes.toString("utf8").split("\0").filter(Boolean);
}

function readTextAtCommit(repoRoot, sha, path) {
  let bytes;
  try {
    bytes = git(repoRoot, ["show", `${sha}:${path}`], { encoding: "buffer" });
  } catch {
    throw new Error(`${path} is missing from commit ${sha}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${path} at commit ${sha} must contain valid UTF-8`);
  }
}

function sourceParent(repoRoot, sourceSha) {
  const fields = git(repoRoot, ["rev-list", "--parents", "-n", "1", sourceSha])
    .trim()
    .split(/\s+/);
  if (fields.length !== 2) {
    throw new Error(
      `release source must have exactly one parent on linear main, found ${fields.length - 1}`,
    );
  }
  return fields[1];
}

function isFirstParentAncestor(repoRoot, ancestor, descendant) {
  return git(repoRoot, ["rev-list", "--first-parent", descendant])
    .trim()
    .split("\n")
    .includes(ancestor);
}

function readStatusAtSource(repoRoot, sourceSha) {
  return readTextAtCommit(repoRoot, sourceSha, statusPath);
}

export function verifyStatusFreshness({
  repoRoot = defaultRepoRoot,
  sourceSha,
}) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? "")) {
    throw new Error(
      "source SHA must be a full lowercase 40-character commit SHA",
    );
  }
  requireCommit(repoRoot, sourceSha, "release source");

  const parentSha = sourceParent(repoRoot, sourceSha);
  const statusContents = readStatusAtSource(repoRoot, sourceSha);
  verifyReleaseEvidencePolicy({
    releasingContents: readTextAtCommit(repoRoot, sourceSha, releasingPath),
    statusContents,
  });
  const { auditSha, auditDate } = parseStatusMarker(statusContents);
  requireCommit(repoRoot, auditSha, "recorded STATUS.md audit source");
  if (!isFirstParentAncestor(repoRoot, auditSha, parentSha)) {
    throw new Error(
      `recorded STATUS.md audit source ${auditSha} is not on the release parent's first-parent history`,
    );
  }

  const staleBeforeRelease = changedPaths(repoRoot, auditSha, parentSha).filter(
    (path) => isReleaseImpactingPath(path) && path !== statusPath,
  );
  if (staleBeforeRelease.length > 0) {
    throw new Error(
      `STATUS.md was not re-derived after release-impacting changes:\n${staleBeforeRelease.map((path) => `- ${path}`).join("\n")}`,
    );
  }

  const sourceDelta = changedPaths(repoRoot, parentSha, sourceSha);
  if (!sourceDelta.includes("wallet/zuuli/release.json")) {
    throw new Error(
      "release source must be the commit that changes wallet/zuuli/release.json",
    );
  }
  const unexpectedSourcePaths = sourceDelta.filter(
    (path) =>
      isReleaseImpactingPath(path) &&
      path !== statusPath &&
      !releaseBumpPaths.has(path),
  );
  if (unexpectedSourcePaths.length > 0) {
    throw new Error(
      `release source contains non-ceremony release-impacting changes:\n${unexpectedSourcePaths.map((path) => `- ${path}`).join("\n")}`,
    );
  }

  let releaseIdentity;
  try {
    releaseIdentity = JSON.parse(
      readTextAtCommit(repoRoot, sourceSha, "wallet/zuuli/release.json"),
    );
  } catch (error) {
    throw new Error(`release source identity is malformed: ${error.message}`);
  }
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(
      releaseIdentity.version ?? "",
    ) ||
    !Number.isSafeInteger(releaseIdentity.build) ||
    releaseIdentity.build < 1 ||
    releaseIdentity.build > 2_100_000_000
  ) {
    throw new Error("release source identity has an invalid version or build");
  }
  let expectedBumpContents;
  try {
    expectedBumpContents = buildReleaseBumpContents({
      read: (path) =>
        readTextAtCommit(repoRoot, parentSha, `wallet/zuuli/${path}`),
      ...releaseIdentity,
    });
  } catch (error) {
    throw new Error(
      `release source identity cannot be reproduced mechanically: ${error.message}`,
    );
  }
  const nonMechanicalBumpPaths = sourceDelta
    .filter((path) => releaseBumpPaths.has(path))
    .filter((path) => {
      const sourceContents = readTextAtCommit(repoRoot, sourceSha, path);
      const relativePath = path.slice("wallet/zuuli/".length);
      const expected = expectedBumpContents.get(relativePath);
      return sourceContents !== expected;
    });
  if (nonMechanicalBumpPaths.length > 0) {
    throw new Error(
      `release source contains non-mechanical changes in release-bump files:\n${nonMechanicalBumpPaths.map((path) => `- ${path}`).join("\n")}`,
    );
  }

  const statusWasReDerived = changedPaths(
    repoRoot,
    auditSha,
    sourceSha,
  ).includes(statusPath);
  if (!statusWasReDerived) {
    throw new Error(
      `STATUS.md at the release source was not committed after its recorded audit source ${auditSha}`,
    );
  }

  return { sourceSha, parentSha, auditSha, auditDate };
}

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

function main() {
  try {
    const result = verifyStatusFreshness({ sourceSha: argument("source-sha") });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`ZUULI status source boundary failed:\n- ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
