#!/usr/bin/env node
//
// Prove that the E2EE hash-domain labels are prefix-free across the whole tree.
//
// `docs/e2ee/WIRE.md` §1.3 defines the one hash the protocol uses as
//
//     H(label, x) = BLAKE2b-256(label || x)
//
// with **no separator and no terminator**. That construction separates domains
// only if the label set is prefix-free. If label `A` is a proper prefix of label
// `B`, then for the suffix `s` with `A || s == B`,
//
//     H(A, s || y) == BLAKE2b-256(A || s || y) == BLAKE2b-256(B || y) == H(B, y)
//
// bit for bit. Separation between those two domains is not weakened, it is
// absent for every `A`-domain message that begins with `s`.
//
// Prefix-freeness is therefore a property of *the set*, not of the
// construction, and a set has no owner. `f2z-codec` already asserted it — over
// its own `LABELS` array (`rs/crates/f2z-codec/src/hash.rs`). That is the right
// shape and the wrong scope: `WIRE.md`'s labels were internally consistent,
// `KT.md`'s labels were internally consistent, and the pair that actually
// collided — `free2z/kt/v1/sth` against `free2z/kt/v1/sth-hash` — lived in a
// document no crate reads (#602). #552 predicted exactly this a document
// earlier. So this check ranges over the **union**: every label in every
// tracked file, specifications and Rust alike.
//
// ## Why this is a script and not a Rust test
//
// Three reasons, each of which would sink a `#[test]` on its own.
//
//   1. `KT.md` has no crate. `f2z-kt-core` and `f2z-authority` are not merged.
//      A Rust test could only assert over a hand-copied restatement of `KT.md`'s
//      label set — and a hand-maintained copy of a document's set drifting from
//      the document is the *same* failure that produced #602.
//   2. The collision arrived in a docs-only pull request. `rs.yml`'s change
//      detector selects `rs=false` for such a diff and skips `rs / tests`
//      entirely, so a Rust test would not have run on the commit that
//      introduced the defect. This script runs from `rs / changes`, which runs
//      on every event unconditionally, and its verdict is re-run inside
//      `rs / gate` where the gate consumes the step outcome.
//   3. The labels are minted in prose. The source of truth is the sentence in
//      the specification that says `opaque label<0..255>` is *exactly* these
//      bytes; reading the documents directly means the check cannot go stale
//      relative to the spec.
//
// ## What counts as a label
//
// A token matching `free2z/<namespace>/v<n>` with an optional `/<leaf>`, in any
// tracked file. The leaf is optional because several domain constants have none
// — `free2z/device-credential/v1` is a `SignedTreeHead`-family signing label in
// `KT.md` §6.2's closed table, `free2z/queue-advert/v1` is a `WIRE.md` §12.2
// document type — and a leafless label is a prefix of *every* leafed label in
// its namespace, which is the sharpest form of the defect this check exists for.
//
// The MLS exporter labels (`free2z/queue/v1`, `free2z/frost/v1`,
// `free2z/webrtc/v1`, `free2z/history/v1`) are swept in as well. They are not
// arguments to `H` — MLS's exporter frames its label — so prefix-freeness is not
// load-bearing for them today. They are included anyway because the cost is
// zero, because the set of constructions a label gets reused in only ever grows,
// and because a check that holds a *subset* of the namespace is exactly how #602
// happened.
//
// Three exclusions, each narrow and each deliberate:
//
//   * **A trailing slash marks a namespace, not a label.** `free2z/relay/v1/`
//     is how the documents and `hash.rs`'s module note refer to the namespace
//     itself. Counting it would make it a prefix of every relay label at once —
//     nine false collisions, no true one. The slash is the whole signal: a
//     leafless `free2z/relay/v1` written without it *is* judged as a label,
//     because that spelling is indistinguishable from a real leafless constant
//     such as `free2z/device-credential/v1`.
//
//   * **Registered fixtures are not labels.** `FIXTURE_TOKENS` names a file, an
//     exact token and a reason. `free2z/relay/v1/cmd2` and
//     `free2z/relay/v1/cmX` are deliberately *wrong* labels, fed to validators
//     to prove they reject them; `free2z/relay/v1/dummy` is signature-check
//     filler. None is a domain.
//
//   * **This file declares nothing.** The checker's own prose quotes labels
//     other files mint, and its self-test fixtures invent labels in reserved
//     `demo`/`other`/`third` namespaces. Scanning it would make the checker
//     report collisions between its own examples. `NON_DECLARING_FILES` names
//     it by exact path and requires that path to be tracked, so renaming the
//     checker fails this check rather than quietly leaving a file unscanned.
//
// The exclusion is by registration and never by heuristic, because every
// available heuristic is wrong here. "It is in a test file" would have dropped
// the six genuine labels `rs/crates/f2z-codec/tests/wire_vectors.rs` pins; "it
// is not in a `LABELS` array" is the scoping mistake this script exists to fix.
// A registered entry that no longer occurs in its file is itself a failure, so
// the registry cannot rot into a blanket excuse for a token nobody can find.
//
// ## The coverage anchor
//
// The union is only a union if the scan reaches the documents.
// `LABEL_BEARING_DOCUMENTS` registers every document under `docs/` that names a
// label, and is checked in both directions:
//
//   * each registered document must exist and must yield at least one label —
//     so a rename, a move, or a scan that quietly stops reading Markdown fails
//     loudly instead of passing over a smaller set;
//   * each tracked `docs/**.md` that yields labels must be registered — so a
//     future `KT.md`-shaped document cannot join the tree without the person
//     adding it being told that its labels now share one namespace with
//     everyone else's.
//
// Without the anchor, narrowing this check to one document is a silent green.
// The self-test proves the anchor fires on exactly that mutation.
//
// Usage:
//   node scripts/check-hash-domain-labels.mjs             judge the tree
//   node scripts/check-hash-domain-labels.mjs --self-test negative controls first

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/// A domain-separation label: the `free2z/` namespace, a version segment, and an
/// optional leaf. The leaf charset is wider than any label in use (`:` for
/// `KT.md`'s `AkdLabel` prefix, `.` and `_` so a malformed neighbour is still
/// seen rather than truncated into a shorter token that collides with nothing).
const LABEL_TOKEN = /free2z\/[a-z0-9-]+\/v[0-9]+(?:\/[A-Za-z0-9:._-]*)?/g;

/// A trailing slash with nothing after it. See the module note: that is how the
/// documents and `hash.rs` name a namespace, and it is not a label. A namespace
/// written *without* the trailing slash is not covered by this and is judged as
/// the leafless label it looks like — which is the conservative direction.
const NAMESPACE_MENTION = /\/$/;

/// Tokens that look like labels and are not, keyed by the exact file they may
/// appear in. Adding an entry is a deliberate act with a written reason; an
/// entry whose token no longer occurs in its file fails this check.
const FIXTURE_TOKENS = [
  {
    file: "rs/crates/f2z-codec/src/transcript.rs",
    token: "free2z/relay/v1/cmd2",
    reason:
      "negative control: the wrong transcript label, asserted to be rejected by CommandTranscript::validate",
  },
  {
    file: "rs/crates/f2z-codec/tests/wire_vectors.rs",
    token: "free2z/relay/v1/cmX",
    reason:
      "negative control: a one-byte corruption of LABEL_COMMAND, asserted to fail the §5.1 vector",
  },
  {
    file: "rs/crates/f2z-relay-proto/src/key.rs",
    token: "free2z/relay/v1/dummy",
    reason:
      "signature-verification filler: an arbitrary message handed to verify() with a zero signature",
  },
];

/// Files that quote labels without declaring any, excluded whole. Exactly one
/// entry, and it is this file: see the module note. Each entry must be a tracked
/// path, so the exclusion cannot outlive the file it excuses.
const NON_DECLARING_FILES = [
  {
    file: "scripts/check-hash-domain-labels.mjs",
    reason:
      "the checker itself: it quotes labels other files mint and invents fixture labels in reserved namespaces",
  },
];

/// Every document under `docs/` that names a label — the specifications that
/// mint them and the index that quotes them. See the module note on the anchor:
/// registered documents must yield labels, and label-naming documents must be
/// registered.
const LABEL_BEARING_DOCUMENTS = [
  "docs/e2ee/ARCHITECTURE.md",
  "docs/e2ee/KT.md",
  "docs/e2ee/README.md",
  "docs/e2ee/THREAT-MODEL.md",
  "docs/e2ee/WIRE.md",
  "docs/e2ee/decisions/0009-queue-addressing-and-binding.md",
  "docs/e2ee/decisions/0010-signing-transcript-and-ack-semantics.md",
];

/// Files under this prefix are subject to the registration half of the anchor.
const DOCS_ROOT = "docs/";

/// A floor on the size of the union, so a scan that reaches almost nothing
/// cannot report a vacuous pass. Deliberately a floor and not an exact count:
/// adding a label should not require editing this file, but losing two thirds
/// of the set should never be quiet.
const MINIMUM_LABELS = 24;

/// Every tracked path, from git. Anything git does not track is invisible here
/// on purpose — a stray untracked scratch file must not be able to fail, or to
/// pass, a policy check that runs on a clean checkout in CI.
function trackedFiles(root) {
  const listing = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return listing.split("\0").filter(Boolean);
}

/// Read a tracked path as text, or `null` when it is not a readable text file
/// (a submodule gitlink, a symlink to nowhere, a binary asset).
function readText(root, relativeFile) {
  const absolute = path.join(root, relativeFile);
  let stats;
  try {
    stats = fs.statSync(absolute);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;
  let text;
  try {
    text = fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
  if (text.includes("\0")) return null;
  return text;
}

function sorted(values) {
  return [...values].sort().join(", ") || "(none)";
}

/// Collect the label union and judge it.
///
/// Every input is injectable so the self-test judges fixtures against fixture
/// configuration: a registration added for the real tree must never change what
/// a self-test case means.
export function scanRepository(root, options = {}) {
  const {
    files = trackedFiles(root),
    fixtures = FIXTURE_TOKENS,
    nonDeclaring = NON_DECLARING_FILES,
    labelBearingDocuments = LABEL_BEARING_DOCUMENTS,
    docsRoot = DOCS_ROOT,
    minimumLabels = MINIMUM_LABELS,
  } = options;

  const failures = [];
  /// label -> Map<file, Set<line number>>
  const labels = new Map();
  const namespaceMentions = new Set();
  const fixtureHits = new Set();
  const labelBearingDocs = new Set();
  let scanned = 0;

  const excused = new Map();
  for (const entry of fixtures) {
    if (!excused.has(entry.file)) excused.set(entry.file, new Set());
    excused.get(entry.file).add(entry.token);
  }

  const skipped = new Set(nonDeclaring.map((entry) => entry.file));
  for (const entry of nonDeclaring) {
    if (files.includes(entry.file)) continue;
    failures.push(
      `NON_DECLARING_FILES excludes ${entry.file}, which is not a tracked file; ` +
        "a stale whole-file exclusion is a file nobody is reading",
    );
  }

  for (const relativeFile of files) {
    if (skipped.has(relativeFile)) continue;
    const text = readText(root, relativeFile);
    if (text === null) continue;
    scanned += 1;
    if (!text.includes("free2z/")) continue;

    for (const [index, line] of text.split(/\r?\n/).entries()) {
      for (const match of line.matchAll(LABEL_TOKEN)) {
        const token = match[0];
        if (NAMESPACE_MENTION.test(token)) {
          namespaceMentions.add(token);
          continue;
        }
        if (excused.get(relativeFile)?.has(token)) {
          fixtureHits.add(`${relativeFile}\0${token}`);
          continue;
        }
        if (!labels.has(token)) labels.set(token, new Map());
        const sites = labels.get(token);
        if (!sites.has(relativeFile)) sites.set(relativeFile, new Set());
        sites.get(relativeFile).add(index + 1);
        if (relativeFile.startsWith(docsRoot)) {
          labelBearingDocs.add(relativeFile);
        }
      }
    }
  }

  // The property. Every ordered pair, both directions, so the message always
  // names the shorter label first.
  const names = [...labels.keys()].sort();
  let collisions = 0;
  for (const shorter of names) {
    for (const longer of names) {
      if (shorter === longer) continue;
      if (!longer.startsWith(shorter)) continue;
      collisions += 1;
      const suffix = longer.slice(shorter.length);
      failures.push(
        `"${shorter}" is a proper prefix of "${longer}": ` +
          `H("${shorter}", "${suffix}" || y) is bit-identical to H("${longer}", y), ` +
          `so those two domains are not separated. ` +
          `${shorter} at ${describe(labels.get(shorter))}; ` +
          `${longer} at ${describe(labels.get(longer))}`,
      );
    }
  }

  // The fixture registry may not carry an entry nobody can find: a stale
  // exclusion is an exclusion that has stopped being reviewed.
  for (const entry of fixtures) {
    if (fixtureHits.has(`${entry.file}\0${entry.token}`)) continue;
    failures.push(
      `FIXTURE_TOKENS excuses "${entry.token}" in ${entry.file}, which no longer contains it; ` +
        "remove the entry rather than leaving an unreviewed exclusion in place",
    );
  }

  // The anchor, both directions.
  for (const document of labelBearingDocuments) {
    if (!files.includes(document)) {
      failures.push(
        `LABEL_BEARING_DOCUMENTS registers ${document}, which is not a tracked file; ` +
          "the union this check reports is smaller than the union it is named for",
      );
      continue;
    }
    if (!labelBearingDocs.has(document)) {
      failures.push(
        `LABEL_BEARING_DOCUMENTS registers ${document}, which yielded no labels; ` +
          "either it stopped minting labels or this scan stopped reading it",
      );
    }
  }
  const unregistered = [...labelBearingDocs].filter(
    (document) => !labelBearingDocuments.includes(document),
  );
  if (unregistered.length) {
    failures.push(
      `${sorted(unregistered)} mint labels but are not in LABEL_BEARING_DOCUMENTS; ` +
        "register them, so that adding a specification is an acknowledgement that its labels " +
        "share one prefix-free namespace with every other document's",
    );
  }

  if (labels.size < minimumLabels) {
    failures.push(
      `the union holds ${labels.size} label(s), below the floor of ${minimumLabels}; ` +
        "a scan that reaches almost nothing must not report a pass",
    );
  }

  return {
    failures,
    labels,
    collisions,
    scanned,
    namespaceMentions: namespaceMentions.size,
    fixtures: fixtureHits.size,
    documents: labelBearingDocs.size,
  };
}

function describe(sites) {
  return [...sites.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([file, lines]) => `${file}:${[...lines].sort((a, b) => a - b)[0]}`)
    .join(", ");
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

/// A minimal tree that passes: two specifications, one crate file, one
/// registered fixture, one bare namespace mention.
const CLEAN_TREE = {
  "docs/spec/ONE.md": [
    "# One",
    'label is exactly `"free2z/demo/v1/alpha"`.',
    '`H("free2z/demo/v1/bravo", x)`',
    "The namespace is `free2z/demo/v1/` and every leaf lives under it.",
  ].join("\n"),
  "docs/spec/TWO.md": [
    "# Two",
    '`H("free2z/other/v1/charlie", x)`',
    '`H("free2z/other/v1/delta", x)`',
  ].join("\n"),
  "src/labels.rs": [
    'pub const LABEL_ALPHA: &[u8] = b"free2z/demo/v1/alpha";',
    'pub const LABEL_BRAVO: &[u8] = b"free2z/demo/v1/bravo";',
    'let wrong = b"free2z/demo/v1/alpha2";',
  ].join("\n"),
};

const CLEAN_OPTIONS = {
  fixtures: [
    {
      file: "src/labels.rs",
      token: "free2z/demo/v1/alpha2",
      reason:
        "self-test fixture: a wrong label asserted to be rejected. It would collide with " +
        "free2z/demo/v1/alpha if it were a domain, which is what makes it worth registering.",
    },
  ],
  nonDeclaring: [],
  labelBearingDocuments: ["docs/spec/ONE.md", "docs/spec/TWO.md"],
  docsRoot: "docs/",
  minimumLabels: 4,
};

/// A file that quotes labels — including one that would collide — and declares
/// none, standing in for the checker itself.
const QUOTING_FILE = [
  "// This tool prints a report about free2z/demo/v1/alpha and would, if it were",
  '// scanned, appear to mint "free2z/demo/v1/alpha-quoted" as a second domain.',
].join("\n");

function withTree(tree, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zuu-label-self-test-"));
  try {
    for (const [relativeFile, text] of Object.entries(tree)) {
      const absolute = path.join(root, relativeFile);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, text);
    }
    return body(root, Object.keys(tree).sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function run(tree, options = {}) {
  return withTree(tree, (root, files) =>
    scanRepository(root, { files, ...CLEAN_OPTIONS, ...options }),
  );
}

let cases = 0;

function expectClean(label, tree, options = {}) {
  const result = run(tree, options);
  if (result.failures.length) {
    throw new Error(
      `self-test FAILED: ${label} should pass, got: ${result.failures.join("; ")}`,
    );
  }
  cases += 1;
  console.log(`self-test: ${label} passes.`);
}

function expectDetected(label, tree, pattern, options = {}) {
  const result = run(tree, options);
  const joined = result.failures.join("; ");
  if (!pattern.test(joined)) {
    throw new Error(
      `self-test FAILED: ${label} was not detected. Failures: ${joined || "(none)"}`,
    );
  }
  cases += 1;
  console.log(`self-test: ${label} is detected.`);
}

/// Replace one file in a fixture tree, refusing a mutation that changed
/// nothing.
///
/// A `String.replace` whose needle does not occur returns the original string
/// silently, so a negative control built on one can end up asserting that the
/// *unmutated* tree fails — which is either a false pass or a false failure,
/// and both look like the check working. This makes that a crash.
function withFile(tree, relativeFile, mutate) {
  const before = tree[relativeFile];
  if (before === undefined) {
    throw new Error(`self-test bug: no fixture file ${relativeFile}`);
  }
  const after = mutate(before);
  if (after === before) {
    throw new Error(
      `self-test bug: the mutation of ${relativeFile} changed nothing`,
    );
  }
  return { ...tree, [relativeFile]: after };
}

function selfTest() {
  expectClean("a prefix-free tree", CLEAN_TREE);

  // The property itself, on a fresh label added to a document.
  expectDetected(
    "a new label that extends an existing one",
    withFile(
      CLEAN_TREE,
      "docs/spec/ONE.md",
      (text) => `${text}\n\`H("free2z/demo/v1/alpha-hash", x)\``,
    ),
    /"free2z\/demo\/v1\/alpha" is a proper prefix of "free2z\/demo\/v1\/alpha-hash"/,
  );

  // The historical case, reproduced verbatim rather than in the abstract: this
  // is the pair #602 found, and the message must name it. A future refactor
  // that keeps the check green on generic input but stops seeing `sth-hash`
  // fails here.
  expectDetected(
    "the KT.md sth / sth-hash collision, verbatim",
    {
      "docs/spec/ONE.md": [
        "# One",
        '    opaque label<0..255>;      /* exactly "free2z/kt/v1/sth" */',
        '    opaque prev_sth_hash[32];  /* H("free2z/kt/v1/sth-hash", tls_codec(prev)) */',
      ].join("\n"),
      "docs/spec/TWO.md": [
        "# Two",
        '`H("free2z/kt/v1/value", x)`',
        '`H("free2z/kt/v1/prev", x)`',
      ].join("\n"),
    },
    /"free2z\/kt\/v1\/sth" is a proper prefix of "free2z\/kt\/v1\/sth-hash".*docs\/spec\/ONE\.md:2.*docs\/spec\/ONE\.md:3/,
    { fixtures: [], minimumLabels: 4 },
  );

  // A collision that spans two documents is the whole reason this ranges over
  // the union: neither document is wrong on its own.
  expectDetected(
    "a collision between two documents, each internally consistent",
    withFile(
      CLEAN_TREE,
      "docs/spec/TWO.md",
      (text) => `${text}\n\`H("free2z/demo/v1/alpha-extended", x)\``,
    ),
    /"free2z\/demo\/v1\/alpha" is a proper prefix of "free2z\/demo\/v1\/alpha-extended"/,
  );

  // A collision in Rust that no document mentions is still a collision.
  expectDetected(
    "a collision minted only in code",
    withFile(
      CLEAN_TREE,
      "src/labels.rs",
      (text) => `${text}\npub const X: &[u8] = b"free2z/demo/v1/bravo-2";`,
    ),
    /"free2z\/demo\/v1\/bravo" is a proper prefix of "free2z\/demo\/v1\/bravo-2"/,
  );

  // Fixtures. The registry is file-scoped and self-invalidating.
  expectDetected(
    "a fixture token that has left its file",
    withFile(CLEAN_TREE, "src/labels.rs", (text) =>
      text.replace('\nlet wrong = b"free2z/demo/v1/alpha2";', ""),
    ),
    /FIXTURE_TOKENS excuses "free2z\/demo\/v1\/alpha2" in src\/labels\.rs, which no longer contains it/,
  );
  expectDetected(
    "the same token in a file the registry does not name",
    withFile(
      CLEAN_TREE,
      "docs/spec/TWO.md",
      (text) => `${text}\n\`H("free2z/demo/v1/alpha2", x)\``,
    ),
    /"free2z\/demo\/v1\/alpha" is a proper prefix of "free2z\/demo\/v1\/alpha2"/,
  );
  // And an unregistered fixture-shaped token is judged as a label, which is the
  // point: no heuristic about test files, only the registry.
  expectDetected(
    "a wrong-label fixture that nobody registered",
    withFile(
      CLEAN_TREE,
      "src/labels.rs",
      (text) => `${text}\nlet other = b"free2z/demo/v1/alpha3";`,
    ),
    /"free2z\/demo\/v1\/alpha" is a proper prefix of "free2z\/demo\/v1\/alpha3"/,
  );

  // Whole-file exclusion: the checker's own self-reference, in miniature.
  expectDetected(
    "a quoting file that nobody excluded",
    { ...CLEAN_TREE, "tools/report.mjs": QUOTING_FILE },
    /"free2z\/demo\/v1\/alpha" is a proper prefix of "free2z\/demo\/v1\/alpha-quoted"/,
  );
  expectClean(
    "a quoting file excluded whole",
    { ...CLEAN_TREE, "tools/report.mjs": QUOTING_FILE },
    {
      nonDeclaring: [
        { file: "tools/report.mjs", reason: "self-test: quotes, declares nothing" },
      ],
    },
  );
  expectDetected(
    "a whole-file exclusion for a file that is no longer tracked",
    CLEAN_TREE,
    /NON_DECLARING_FILES excludes tools\/report\.mjs, which is not a tracked file/,
    {
      nonDeclaring: [
        { file: "tools/report.mjs", reason: "self-test: quotes, declares nothing" },
      ],
    },
  );

  // The bare namespace. It must not be a label, and its exclusion must not be
  // wide enough to swallow a leaf.
  expectClean(
    "a bare namespace mention alongside every label under it",
    withFile(
      CLEAN_TREE,
      "docs/spec/TWO.md",
      (text) => `${text}\nEverything lives under \`free2z/other/v1/\`.`,
    ),
  );

  // The coverage anchor, both directions. Narrowing the check to one document
  // is the mutation it exists to catch.
  expectDetected(
    "the check narrowed to a single document",
    CLEAN_TREE,
    /LABEL_BEARING_DOCUMENTS registers docs\/spec\/TWO\.md, which yielded no labels|docs\/spec\/TWO\.md mint labels but are not in LABEL_BEARING_DOCUMENTS/,
    { labelBearingDocuments: ["docs/spec/ONE.md"] },
  );
  expectDetected(
    "a registered document that is no longer tracked",
    CLEAN_TREE,
    /LABEL_BEARING_DOCUMENTS registers docs\/spec\/THREE\.md, which is not a tracked file/,
    {
      labelBearingDocuments: ["docs/spec/ONE.md", "docs/spec/TWO.md", "docs/spec/THREE.md"],
    },
  );
  expectDetected(
    "a registered document that has stopped minting labels",
    withFile(CLEAN_TREE, "docs/spec/TWO.md", () => "# Two\n\nNothing here.\n"),
    /LABEL_BEARING_DOCUMENTS registers docs\/spec\/TWO\.md, which yielded no labels/,
  );
  expectDetected(
    "a new specification nobody registered",
    {
      ...CLEAN_TREE,
      "docs/spec/THREE.md": '# Three\n`H("free2z/third/v1/echo", x)`\n',
    },
    /docs\/spec\/THREE\.md mint labels but are not in LABEL_BEARING_DOCUMENTS/,
  );

  // The floor. A scan that reaches almost nothing looks exactly like a pass.
  expectDetected(
    "a union far below its floor",
    CLEAN_TREE,
    /the union holds 4 label\(s\), below the floor of 40/,
    { minimumLabels: 40 },
  );

  console.log(`check-hash-domain-labels self-test: ${cases} case(s) passed.`);
}

const mode = process.argv[2];
if (mode && mode !== "--self-test") {
  console.error("usage: node scripts/check-hash-domain-labels.mjs [--self-test]");
  process.exit(2);
}

if (mode === "--self-test") {
  selfTest();
  process.exit(0);
}

const result = scanRepository(REPO_ROOT);
if (result.failures.length) {
  console.error("Hash-domain label separation failed:");
  for (const failure of result.failures) console.error(`- ${failure}`);
  console.error(
    `${result.failures.length} failure(s) over ${result.labels.size} label(s) ` +
      `from ${result.scanned} tracked file(s).`,
  );
  process.exit(1);
}
console.log(
  `No label is a proper prefix of another: ${result.labels.size} label(s) across ` +
    `${result.documents} registered document(s) under docs/ and the crates under rs/, ` +
    `read from ${result.scanned} tracked file(s) ` +
    `(${result.namespaceMentions} bare namespace mention(s) and ` +
    `${result.fixtures} registered fixture token(s) excluded).`,
);
