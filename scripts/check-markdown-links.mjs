#!/usr/bin/env node
//
// Prove that every relative link in tracked Markdown resolves — the file *and*
// the heading it names.
//
// The repository had no link check at all until this one. That was survivable
// while the documentation was a handful of long specifications that linked
// mostly to each other; #932 ended it by splitting the root `README.md` into a
// concise entry point plus `docs/architecture.md`, `docs/status.md` and
// `docs/development.md`, which multiplied the internal cross-linking. A dead
// link in the first document anybody reads is the cheapest possible signal that
// nothing here is maintained, and it is exactly the kind of rot no test, no
// build and no reviewer reliably catches.
//
// ## Two kinds of link, and only one of them is the interesting one
//
// A **path** link — `./ARCHITECTURE.md`, `../wallet/zuuli/`, `scripts/` — breaks
// when a file is renamed or moved. That is real, and it is checked here, but it
// is also rare: paths move under a `git mv` that the person doing it is thinking
// about.
//
// An **anchor** link — `../AGENTS.md#verifying-before-you-push`,
// `./architecture.md#4-what-enforces-the-boundary` — breaks when somebody
// rewords a heading, which happens constantly and which nobody connects to a
// link three directories away. A checker that resolves only the path half passes
// both of those links after the heading is renamed *or deleted*. So anchors are
// not an extra: they are most of the value, and the slug rules below are
// implemented to match GitHub's renderer rather than approximated, because an
// anchor checker that is merely close produces false failures and gets disabled.
//
// ## What is deliberately out of scope
//
//   * **External URLs.** `https://…` is never fetched, in any mode, and there is
//     no flag that would make it happen. Every other checker in this repository
//     is deterministic and offline; a network-dependent required check reddens
//     `main` for a contributor who touched nothing, on somebody else's outage or
//     rate limit. A link to a repository that has gone private is a real defect
//     this will never find, and that is the trade.
//
//   * **Site-absolute targets** — anything beginning with `/`. Those are router
//     routes, not repository paths: `/img/begin.png` is served by Docusaurus out
//     of `static/`, `/revenue-sharing` is a page slug. Resolving them against the
//     repository root would report every one of them as missing. They occur only
//     under the Docusaurus site (see `SITE_ROUTE_ROOTS`, which is checked in both
//     directions so this exemption cannot silently spread).
//
//   * **The vendored tree under `z/`.** Thirty upstream Zcash-ecosystem
//     repositories are submodules, so their Markdown is not ours to govern and
//     "fixing" a broken link in one would mean editing vendored code. The
//     mechanism is `git ls-files`, which reports a submodule as a single gitlink
//     and never as the files inside it — so nothing under `z/` is scanned, for
//     free. That is quiet enough to be an accident, so `scanRepository` states
//     it as a property — a Markdown file under `VENDOR_ROOT` is a failure — and
//     the self-test exercises it. Do not "fix" the omission; it is the point.
//
// ## Registries, and why each one is self-invalidating
//
// Three registries below carry exemptions, and every one of them fails when it
// stops being true: an entry naming a path the enumeration did not produce is an
// error, and an entry whose situation has resolved is an error. An exemption
// nobody is forced to re-read is an exemption that outlives its reason — the
// failure mode this repository has already seen in a workflow registration that
// went on describing a job as build-only for months after test suites moved into
// it.
//
// ## The floor and the coverage anchor
//
// A link checker that stops finding links is indistinguishable from a link
// checker that finds no broken ones. Both print a green line. So the scan
// asserts a floor on the number of Markdown files read, on the number of
// relative links judged and on the number of *anchors* judged — that last one
// separately, because dropping anchor resolution while keeping path resolution
// is precisely the regression that turns this tool into a decoration, and it
// would leave the other two counts untouched.
//
// Usage:
//   node scripts/check-markdown-links.mjs             judge the tree
//   node scripts/check-markdown-links.mjs --self-test negative controls first

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/// The vendored submodule tree. `git ls-files` never descends into a submodule,
/// so this prefix should never appear among the scanned Markdown files; the
/// assertion below turns that accident into a stated property.
const VENDOR_ROOT = "z/";

/// Roots whose Markdown is resolved by a site router rather than by the
/// filesystem, and where a `/`-rooted target is therefore a route and not a
/// repository path.
///
/// `docs/about-free2z/` is a Docusaurus site: `/img/begin.png` comes from its
/// `static/` directory, `/revenue-sharing` is a page slug, and both are correct
/// links that would resolve to nothing under the repository root. The site has
/// its own build (`.github/workflows/docs-about-free2z.yml`), which is what
/// judges them.
///
/// Checked in both directions. Each root must contain at least one tracked
/// Markdown file, and a site-absolute target appearing *outside* every root
/// fails — so this exemption cannot quietly spread to documents that have no
/// router and where `/docs/architecture.md` is simply wrong.
const SITE_ROUTE_ROOTS = [
  {
    root: "docs/about-free2z/",
    reason:
      "Docusaurus site: `/`-rooted targets are static-asset and page routes resolved by the " +
      "site's own router and build (.github/workflows/docs-about-free2z.yml), not paths under " +
      "the repository root.",
  },
];

/// Relative targets that carry no file extension and are resolved by something
/// other than the filesystem, keyed by the exact file that may write them.
///
/// Empty, and it should stay that way. Docusaurus document ids are *resolved*
/// rather than excused — see `resolveDocumentId` — because a link this checker
/// cannot follow is a link whose anchor it also cannot check, and inside
/// `docs/about-free2z/` that would mean giving up on forty files. This registry
/// exists for a target no resolution rule can reach, and the cost of an entry is
/// a written reason.
///
/// An entry whose target no longer appears in its file fails.
const ROUTER_RESOLVED_TARGETS = [];

/// Links that are known-broken and deliberately not fixed here, each with a
/// reason. Empty is the desired state.
///
/// An entry that has been fixed fails, so this cannot become a place where
/// breakage accumulates: the registration dies with the defect.
const KNOWN_BROKEN_LINKS = [
  {
    file: "py/dj/proj/zuu/README.md",
    target: "../../../requirements/main.txt",
    reason:
      "The link is correct about where the file would be — `py/requirements/main.txt`, which " +
      "is exactly what the same README's own quickstart tells you to `pip install -r` — and " +
      "the file is absent because only *parts* of the Free2Z backend are open-sourced into " +
      "this public repository; the requirements manifest stays in the private backend repo. " +
      "So there is no correct edit available from here: publishing the manifest is a decision " +
      "about what to open-source, and deleting the link would hide that the quickstart names " +
      "a file the reader cannot get. Registered rather than guessed at, and this entry fails " +
      "the moment somebody resolves it either way.",
  },
];

/// Floors. Deliberately floors and not exact counts — adding a document should
/// not require editing this file — but losing most of the population, or losing
/// anchor resolution entirely, must never be quiet. `MINIMUM_ANCHORS` is
/// separate on purpose: a refactor that keeps resolving paths and stops
/// resolving anchors leaves the other two numbers untouched and is the single
/// most likely way this check becomes decorative.
const MINIMUM_DOCUMENTS = 80;
const MINIMUM_RELATIVE_LINKS = 500;
const MINIMUM_ANCHORS = 300;

/// The shortest string that can pass as a recorded reason. `""` — what a hurried
/// edit reaches for — is red rather than a silent exemption.
const MINIMUM_REGISTRY_REASON = 40;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/// Every tracked path, from git. Untracked scratch files are invisible on
/// purpose: a policy check that runs on a clean checkout in CI must not be
/// reachable by a file that only exists on somebody's laptop. This is also what
/// excludes `z/` — git reports each submodule as one gitlink, never as the
/// files inside it.
function trackedFiles(root) {
  const listing = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return listing.split("\0").filter(Boolean);
}

/// The submodule roots, read from the index as mode-160000 entries.
///
/// A gitlink is one tracked path standing for a whole repository, so
/// `docs/DEPENDENCIES.md`'s link to `../z/zcash/librustzcash/Cargo.toml` is a
/// link *into* a submodule: correct, and resolvable by GitHub and by anyone with
/// `--recurse-submodules`, but invisible to `git ls-files` here. Treating those
/// as missing would be a false failure on every link into the vendored tree.
/// They resolve, and nothing inside them is read — same boundary as everywhere
/// else in this file.
function submoduleRoots(root) {
  const listing = execFileSync("git", ["-C", root, "ls-files", "-s", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const roots = [];
  for (const entry of listing.split("\0")) {
    if (!entry.startsWith("160000 ")) continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    roots.push(entry.slice(tab + 1));
  }
  return roots;
}

// ---------------------------------------------------------------------------
// Markdown reading
// ---------------------------------------------------------------------------

const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const ATX_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*$/;

/// Walk a document's lines, yielding only those outside fenced code blocks.
///
/// Fences matter in both directions here: a ```` ```md ```` sample containing
/// `[a](./nowhere.md)` is not a link this repository is claiming, and a `#`
/// comment inside a shell block is not a heading that publishes an anchor. The
/// `docs/` tree is full of both.
function* proseLines(text) {
  let fence = null;
  const all = text.split(/\r?\n/);
  // YAML front matter, which most of the Docusaurus tree carries. Skipping it
  // matters in both directions: `title: Creating a profile` sitting above a
  // closing `---` is otherwise read as a setext heading and publishes an anchor
  // nothing renders, and a `slug:` value is not a link.
  let start = 0;
  if (all[0]?.trim() === "---") {
    for (let index = 1; index < all.length; index += 1) {
      if (all[index].trim() !== "---") continue;
      start = index + 1;
      break;
    }
  }
  for (const [offset, raw] of all.slice(start).entries()) {
    const index = offset + start;
    const match = FENCE.exec(raw);
    if (match) {
      if (fence === null) {
        fence = match[1];
      } else if (
        raw.trimStart().startsWith(fence[0]) &&
        raw.trim().replace(/[^`~]/g, "").length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;
    yield { line: index + 1, raw };
  }
}

/// Blank out inline code spans, preserving length so nothing else shifts.
///
/// A backtick span is opaque to the link syntax: `` `[a](b)` `` is a literal,
/// not a link. Blanking rather than deleting keeps the reported position honest.
function blankCodeSpans(line) {
  return line.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, (span) => " ".repeat(span.length));
}

/// The rendered text of a heading, with the markup GitHub strips before slugging
/// removed: code spans keep their contents, links keep their text, emphasis
/// markers and raw HTML tags go.
function headingText(raw) {
  let text = raw;
  text = text.replace(/`+([^`]*)`+/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/\*\*|__|\*|_|~~/g, "");
  text = text.replace(/\s+#+\s*$/, "");
  return text.trim();
}

/// GitHub's heading slug.
///
/// Lowercase, drop everything that is not a letter, a number, a combining mark,
/// an underscore, a hyphen or a space, then turn spaces into hyphens. Duplicate
/// slugs within one document get `-1`, `-2`, … in document order — which is
/// GitHub's rule and the only reason `#4-what-enforces-the-boundary` and
/// `#7-application-framing--hash-linked-causal-ordering` come out right: the
/// leading numeral survives, the `.` after it does not, and an em dash between
/// two words leaves the two spaces that flank it, hence the doubled hyphen.
function slugOf(text) {
  // Note the two things this deliberately does not do, both of which GitHub
  // also does not do: it does not trim after removing punctuation (so a heading
  // opening with an emoji keeps the space that followed it and slugs with a
  // leading hyphen), and it does not collapse runs of spaces (so the two spaces
  // flanking a removed em dash become two hyphens, which is why
  // `#7-application-framing--hash-linked-causal-ordering` is spelled that way).
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_ -]/gu, "")
    .replace(/ /g, "-");
}

/// Every anchor a Markdown document publishes, in document order.
export function anchorsOf(text) {
  const anchors = new Set();
  const seen = new Map();
  const add = (base) => {
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  };

  const lines = [...proseLines(text)];
  for (const [index, { raw }] of lines.entries()) {
    const atx = ATX_HEADING.exec(raw);
    if (atx) {
      add(slugOf(headingText(atx[2])));
      continue;
    }
    // Setext headings: a line of text underlined by `===` or `---`.
    const next = lines[index + 1]?.raw ?? "";
    if (raw.trim() && /^\s{0,3}(=+|-{2,})\s*$/.test(next)) {
      add(slugOf(headingText(raw)));
      continue;
    }
    // Explicit HTML anchors, which GitHub honours alongside heading slugs.
    for (const match of raw.matchAll(/<a[^>]*\s(?:id|name)=["']([^"']+)["']/gi)) {
      anchors.add(match[1]);
    }
    for (const match of raw.matchAll(/<(?:h[1-6]|div|span|p)[^>]*\sid=["']([^"']+)["']/gi)) {
      anchors.add(match[1]);
    }
  }
  return anchors;
}

/// Balanced-parenthesis link targets, plus reference definitions.
///
/// A regex over `](…)` cannot be naive: this tree writes
/// `[`z/`](z/)` (a code span inside the link text) and
/// `[foo](https://example.com/a_(b))` (parentheses inside the target). The scan
/// finds `](`, then walks forward tracking depth, which reads both exactly.
export function linksOf(text) {
  const found = [];
  for (const { line, raw } of proseLines(text)) {
    const scrubbed = blankCodeSpans(raw);

    for (let index = 0; index < scrubbed.length - 1; index += 1) {
      if (scrubbed[index] !== "]" || scrubbed[index + 1] !== "(") continue;
      let depth = 1;
      let cursor = index + 2;
      while (cursor < scrubbed.length && depth > 0) {
        if (scrubbed[cursor] === "(") depth += 1;
        else if (scrubbed[cursor] === ")") depth -= 1;
        if (depth === 0) break;
        cursor += 1;
      }
      if (depth !== 0) continue;
      const target = destinationOf(scrubbed.slice(index + 2, cursor));
      if (target !== null) found.push({ line, target });
      index = cursor;
    }

    // Reference definitions: `[label]: target "optional title"`.
    const reference = /^\s{0,3}\[([^\]]+)\]:\s*(\S+)/.exec(scrubbed);
    if (reference) found.push({ line, target: destinationOf(reference[2]) ?? "" });
  }
  return found;
}

/// Strip a link destination out of the raw text between `(` and `)`: an optional
/// `<…>` wrapper, and an optional trailing title.
function destinationOf(inner) {
  const text = inner.trim();
  if (text.startsWith("<")) {
    const close = text.indexOf(">");
    if (close < 0) return null;
    return text.slice(1, close).trim();
  }
  const match = /^([^\s]*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?$/.exec(text);
  if (!match) return text.split(/\s+/)[0];
  return match[1];
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

const SCHEME = /^[a-z][a-z0-9+.\-]*:/i;

/// Resolve a Docusaurus document id to the file that publishes it.
///
/// Inside a docs site, `./tuzis` is not a path: it is the id of the document at
/// `03-tuzis.md`, because Docusaurus's default `numberPrefixParser` strips a
/// leading `NN-` from the filename when it computes the id. `../for-creators/
/// free2z-live` reaches `03-free2z-live.md` the same way, and `./index` reaches
/// a directory's `index.md`.
///
/// This is resolution, not exemption. A link to `./nonexistent` inside the site
/// still fails, and — the part that matters — resolving the id means the anchor
/// after it (`#free2z-flavored-markdown-features`) gets checked against the real
/// document's headings, which an exemption would have skipped.
function resolveDocumentId(joined, tracked) {
  const directory = path.posix.dirname(joined);
  const base = path.posix.basename(joined);
  for (const extension of [".md", ".mdx"]) {
    const direct = `${joined}${extension}`;
    if (tracked.has(direct)) return direct;
    const indexed = path.posix.join(joined, `index${extension}`);
    if (tracked.has(indexed)) return indexed;
  }
  // The numeric sidebar prefix. Scan rather than guess the width: the tree uses
  // two digits today and nothing promises it always will.
  const prefixed = /^(\d+-)?(.*)$/;
  for (const candidate of tracked) {
    if (path.posix.dirname(candidate) !== directory) continue;
    if (!/\.mdx?$/.test(candidate)) continue;
    const name = path.posix.basename(candidate).replace(/\.mdx?$/, "");
    const match = prefixed.exec(name);
    if (match && match[1] && match[2] === base) return candidate;
  }
  return null;
}

export function scanRepository(root, options = {}) {
  const {
    files = trackedFiles(root),
    submodules = safeSubmoduleRoots(root),
    read = (relativeFile) =>
      fs.readFileSync(path.join(root, relativeFile), "utf8"),
    siteRouteRoots = SITE_ROUTE_ROOTS,
    routerResolved = ROUTER_RESOLVED_TARGETS,
    knownBroken = KNOWN_BROKEN_LINKS,
    minimumDocuments = MINIMUM_DOCUMENTS,
    minimumRelativeLinks = MINIMUM_RELATIVE_LINKS,
    minimumAnchors = MINIMUM_ANCHORS,
    minimumReason = MINIMUM_REGISTRY_REASON,
    vendorRoot = VENDOR_ROOT,
  } = options;

  const failures = [];
  const tracked = new Set(files);
  const directories = new Set();
  for (const file of files) {
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      directories.add(`${parts.slice(0, depth).join("/")}/`);
    }
  }

  const documents = files.filter((file) => file.endsWith(".md"));

  // The vendored tree, stated rather than assumed. See the module note.
  for (const document of documents) {
    if (!document.startsWith(vendorRoot)) continue;
    failures.push(
      `${document} is under ${vendorRoot}, the vendored submodule tree, and must not be ` +
        "scanned: those repositories' links are not ours to govern and fixing one would mean " +
        "editing vendored code",
    );
  }

  failures.push(...registryFailures(siteRouteRoots, "SITE_ROUTE_ROOTS", minimumReason));
  failures.push(
    ...registryFailures(routerResolved, "ROUTER_RESOLVED_TARGETS", minimumReason),
  );
  failures.push(...registryFailures(knownBroken, "KNOWN_BROKEN_LINKS", minimumReason));

  for (const entry of siteRouteRoots) {
    if (documents.some((document) => document.startsWith(entry.root))) continue;
    failures.push(
      `SITE_ROUTE_ROOTS registers ${entry.root}, which holds no tracked Markdown; ` +
        "a root nobody can reach is an exemption nobody is reviewing",
    );
  }

  const routerHits = new Set();
  const routerIndex = new Map();
  for (const entry of routerResolved) {
    if (!routerIndex.has(entry.file)) routerIndex.set(entry.file, new Set());
    routerIndex.get(entry.file).add(entry.target);
  }
  const brokenHits = new Set();
  const brokenIndex = new Map();
  for (const entry of knownBroken) {
    if (!brokenIndex.has(entry.file)) brokenIndex.set(entry.file, new Set());
    brokenIndex.get(entry.file).add(entry.target);
  }

  const anchorCache = new Map();
  const anchorsFor = (relativeFile) => {
    if (!anchorCache.has(relativeFile)) {
      let anchors = null;
      try {
        anchors = anchorsOf(read(relativeFile));
      } catch {
        // Unreadable (a symlink to nowhere, a file only the index knows about).
        // `null` means "cannot judge", never "publishes nothing" — the latter
        // would report every anchor into it as broken.
        anchors = null;
      }
      anchorCache.set(relativeFile, anchors);
    }
    return anchorCache.get(relativeFile);
  };

  let relativeLinks = 0;
  let anchorsChecked = 0;
  let external = 0;
  let siteRoutes = 0;
  let submoduleTargets = 0;
  let scanned = 0;

  for (const document of documents) {
    if (document.startsWith(vendorRoot)) continue;
    let text;
    try {
      text = read(document);
    } catch {
      continue;
    }
    scanned += 1;

    for (const { line, target } of linksOf(text)) {
      const where = `${document}:${line}`;
      if (!target) continue;
      if (SCHEME.test(target) || target.startsWith("//")) {
        external += 1;
        continue;
      }

      if (target.startsWith("/")) {
        const site = siteRouteRoots.find((entry) =>
          document.startsWith(entry.root),
        );
        if (site) {
          siteRoutes += 1;
          continue;
        }
        failures.push(
          `${where}: "${target}" is a site-absolute target in a document that no router serves. ` +
            "Repository Markdown is read from the filesystem, so `/` resolves to nothing; " +
            "write a path relative to this file instead",
        );
        continue;
      }

      const excused = brokenIndex.get(document)?.has(target);
      if (excused) brokenHits.add(`${document}\0${target}`);

      const hash = target.indexOf("#");
      const rawPath = hash < 0 ? target : target.slice(0, hash);
      const rawAnchor = hash < 0 ? "" : target.slice(hash + 1);
      relativeLinks += 1;

      let resolved = null;
      if (rawPath === "") {
        resolved = document;
      } else {
        const decoded = decodeTarget(rawPath);
        if (decoded === null) {
          if (!excused) {
            failures.push(
              `${where}: "${target}" is not a decodable path (bad percent-encoding)`,
            );
          }
          continue;
        }
        const joined = path.posix.normalize(
          path.posix.join(path.posix.dirname(document), decoded),
        );
        if (joined.startsWith("../")) {
          if (!excused) {
            failures.push(
              `${where}: "${target}" escapes the repository root (resolves to ${joined})`,
            );
          }
          continue;
        }
        const asDirectory = `${joined.replace(/\/$/, "")}/`;
        const inSubmodule = submodules.some(
          (submodule) => joined === submodule || joined.startsWith(`${submodule}/`),
        );
        const documentId =
          siteRouteRoots.some((entry) => document.startsWith(entry.root)) &&
          !/\.[a-z0-9]+$/i.test(joined)
            ? resolveDocumentId(joined, tracked)
            : null;
        if (tracked.has(joined)) {
          resolved = joined;
        } else if (directories.has(asDirectory)) {
          // A directory link. Nothing to resolve an anchor against, and a
          // README inside it is the renderer's business, not this check's.
          resolved = null;
        } else if (inSubmodule) {
          // A path inside a vendored repository: it resolves, and this checker
          // reads nothing in there. See `submoduleRoots`.
          submoduleTargets += 1;
          resolved = null;
        } else if (documentId) {
          resolved = documentId;
        } else if (routerIndex.get(document)?.has(target)) {
          routerHits.add(`${document}\0${target}`);
          continue;
        } else {
          if (!excused) {
            failures.push(
              `${where}: "${target}" resolves to ${joined}, which is not a tracked file or ` +
                "directory",
            );
          }
          continue;
        }
      }

      if (!rawAnchor) continue;
      if (resolved === null || !/\.mdx?$/.test(resolved)) {
        // `zuuli.yml#L20` and friends are line anchors GitHub synthesizes for
        // any blob; there is no set of names to check them against.
        continue;
      }
      const anchor = decodeTarget(rawAnchor);
      if (anchor === null) {
        if (!excused) {
          failures.push(
            `${where}: "${target}" has an undecodable anchor (bad percent-encoding)`,
          );
        }
        continue;
      }
      const available = anchorsFor(resolved);
      if (available === null) continue;
      anchorsChecked += 1;
      if (available.has(anchor)) continue;
      if (excused) continue;
      failures.push(
        `${where}: "${target}" points at heading anchor #${anchor} in ${resolved}, which ` +
          `publishes no such anchor${nearest(anchor, available)}`,
      );
    }
  }

  // Registries die with the situations that justified them.
  for (const entry of routerResolved) {
    if (routerHits.has(`${entry.file}\0${entry.target}`)) continue;
    failures.push(
      `ROUTER_RESOLVED_TARGETS excuses "${entry.target}" in ${entry.file}, which no longer ` +
        "writes it as an unresolvable link; remove the entry rather than leaving an " +
        "unreviewed exemption in place",
    );
  }
  for (const entry of knownBroken) {
    if (brokenHits.has(`${entry.file}\0${entry.target}`)) continue;
    failures.push(
      `KNOWN_BROKEN_LINKS excuses "${entry.target}" in ${entry.file}, which no longer ` +
        "contains it; the registration must die with the defect",
    );
  }

  if (scanned < minimumDocuments) {
    failures.push(
      `read ${scanned} Markdown document(s), below the floor of ${minimumDocuments}; ` +
        "a scan that reaches almost nothing must not report a pass",
    );
  }
  if (relativeLinks < minimumRelativeLinks) {
    failures.push(
      `judged ${relativeLinks} relative link(s), below the floor of ${minimumRelativeLinks}; ` +
        "a checker that stops finding links looks exactly like a checker that found none broken",
    );
  }
  if (anchorsChecked < minimumAnchors) {
    failures.push(
      `resolved ${anchorsChecked} heading anchor(s), below the floor of ${minimumAnchors}; ` +
        "path resolution alone would leave every renamed heading unchecked, which is the " +
        "likelier rot and most of the reason this check exists",
    );
  }

  return {
    failures,
    scanned,
    relativeLinks,
    anchorsChecked,
    external,
    siteRoutes,
    submoduleTargets,
  };
}

/// `submoduleRoots`, tolerating a root that is not a git repository — which is
/// what a self-test fixture directory is.
function safeSubmoduleRoots(root) {
  try {
    return submoduleRoots(root);
  } catch {
    return [];
  }
}

/// Shared shape assertions for the three registries: every entry must carry a
/// substantive reason, so an exemption costs a sentence rather than a comma.
function registryFailures(entries, name, minimumReason) {
  const failures = [];
  for (const entry of entries) {
    const reason = entry.reason ?? "";
    if (reason.length >= minimumReason) continue;
    failures.push(
      `${name} has an entry (${entry.root ?? `${entry.file} -> ${entry.target}`}) whose ` +
        `reason is ${reason.length} character(s), below the ${minimumReason} required; ` +
        "an exemption nobody had to justify is an exemption nobody reviews",
    );
  }
  return failures;
}

function decodeTarget(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/// The closest published anchor, when there is an obvious one. A renamed heading
/// is the common case and naming the survivor turns a report into a fix.
function nearest(anchor, available) {
  let best = null;
  let bestScore = 0;
  for (const candidate of available) {
    const score = overlap(anchor, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (!best || bestScore < 0.6) {
    const sample = [...available].slice(0, 4);
    return sample.length ? `. It publishes: ${sample.join(", ")}` : "";
  }
  return `. Did you mean #${best}?`;
}

function overlap(left, right) {
  const a = new Set(left.split("-").filter(Boolean));
  const b = new Set(right.split("-").filter(Boolean));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

/// A minimal tree that passes: a root document linking out by path and by
/// anchor, a target with duplicate headings, a directory link, a link to a
/// non-Markdown file with a line anchor, and a site with router-resolved links.
const CLEAN_TREE = {
  "README.md": [
    "# Zuu",
    "",
    "See [architecture](docs/architecture.md) and its",
    "[boundary section](docs/architecture.md#4-what-enforces-the-boundary).",
    "The [scripts](scripts/) directory holds the checks, and",
    "[the workflow](.github/workflows/rs.yml#L20) runs them.",
    "Back to [the top](#zuu).",
    "",
    "```md",
    "This sample link is not ours: [nope](./does-not-exist.md).",
    "```",
    "",
    "A literal `[nope](./also-missing.md)` is not a link either.",
    "External: [rfc](https://example.com/a_(b)) and [mail](mailto:x@example.com).",
  ].join("\n"),
  "docs/architecture.md": [
    "# Architecture",
    "",
    "## 4. What enforces the boundary",
    "",
    "Up to [the readme](../README.md#zuu).",
    "",
    "## Notes",
    "",
    "## Notes",
    "",
    "Second one is [#notes-1](./architecture.md#notes-1).",
  ].join("\n"),
  ".github/workflows/rs.yml": "name: rs\n",
  "scripts/check-markdown-links.mjs": "// placeholder\n",
  "docs/about-free2z/docs/overview.md": [
    "# Overview",
    "",
    "![shot](/img/begin.png) and [revenue](/revenue-sharing).",
  ].join("\n"),
};

const CLEAN_OPTIONS = {
  siteRouteRoots: [
    {
      root: "docs/about-free2z/",
      reason:
        "self-test: a Docusaurus site whose `/`-rooted targets are routes served by its own " +
        "build rather than paths under the repository root",
    },
  ],
  routerResolved: [],
  knownBroken: [],
  submodules: [],
  minimumDocuments: 3,
  minimumRelativeLinks: 6,
  minimumAnchors: 4,
};

function withTree(tree, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zuu-link-self-test-"));
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

/// Replace one file in a fixture tree, refusing a mutation that changed nothing.
///
/// A `String.replace` whose needle does not occur returns the original string
/// silently, so a negative control built on one can end up asserting that the
/// *unmutated* tree fails — a false pass and a false failure look identical from
/// outside. This makes that a crash.
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

function expectSlug(heading, expected) {
  const actual = slugOf(headingText(heading));
  if (actual !== expected) {
    throw new Error(
      `self-test FAILED: slug of ${JSON.stringify(heading)} is ${JSON.stringify(actual)}, ` +
        `expected ${JSON.stringify(expected)}`,
    );
  }
  cases += 1;
}

function selfTest() {
  expectClean("a tree whose links all resolve", CLEAN_TREE);

  // ---- paths -------------------------------------------------------------
  expectDetected(
    "a link to a file that does not exist",
    withFile(CLEAN_TREE, "README.md", (text) =>
      text.replace("(docs/architecture.md)", "(docs/architektur.md)"),
    ),
    /README\.md:3: "docs\/architektur\.md" resolves to docs\/architektur\.md, which is not a tracked file or directory/,
  );
  expectDetected(
    "a renamed target file, seen from the document that links up to it",
    withFile(CLEAN_TREE, "docs/architecture.md", (text) =>
      text.replace("(../README.md#zuu)", "(../READMEE.md#zuu)"),
    ),
    /docs\/architecture\.md:5: "\.\.\/READMEE\.md#zuu" resolves to READMEE\.md/,
  );
  expectDetected(
    "a link to a directory that does not exist",
    withFile(CLEAN_TREE, "README.md", (text) =>
      text.replace("(scripts/)", "(script/)"),
    ),
    /README\.md:5: "script\/" resolves to script\/, which is not a tracked file or directory/,
  );
  expectDetected(
    "a relative link that escapes the repository root",
    withFile(CLEAN_TREE, "README.md", (text) =>
      text.replace("(docs/architecture.md)", "(../outside/architecture.md)"),
    ),
    /escapes the repository root/,
  );

  // ---- anchors: the case a path-only checker misses entirely --------------
  expectDetected(
    "an anchor whose heading was renamed",
    withFile(CLEAN_TREE, "docs/architecture.md", (text) =>
      text.replace(
        "## 4. What enforces the boundary",
        "## 4. What actually enforces the boundary",
      ),
    ),
    /README\.md:4: "docs\/architecture\.md#4-what-enforces-the-boundary" points at heading anchor #4-what-enforces-the-boundary in docs\/architecture\.md, which publishes no such anchor\. Did you mean #4-what-actually-enforces-the-boundary\?/,
  );
  expectDetected(
    "an anchor whose heading was deleted",
    withFile(CLEAN_TREE, "docs/architecture.md", (text) =>
      text.replace("## 4. What enforces the boundary\n\n", ""),
    ),
    /points at heading anchor #4-what-enforces-the-boundary/,
  );
  expectDetected(
    "a same-document anchor that nothing publishes",
    withFile(CLEAN_TREE, "README.md", (text) =>
      text.replace("(#zuu)", "(#zuuu)"),
    ),
    /README\.md:7: "#zuuu" points at heading anchor #zuuu in README\.md/,
  );
  expectDetected(
    "a duplicate-heading suffix that no longer exists",
    withFile(CLEAN_TREE, "docs/architecture.md", (text) =>
      text.replace("## Notes\n\n## Notes", "## Notes\n\n## Other"),
    ),
    /points at heading anchor #notes-1 in docs\/architecture\.md/,
  );

  // ---- fences and code spans are not links -------------------------------
  expectDetected(
    "a broken link that escapes its fence",
    withFile(CLEAN_TREE, "README.md", (text) => text.replace("```md\n", "")),
    /"\.\/does-not-exist\.md" resolves to does-not-exist\.md/,
  );

  // ---- YAML front matter -------------------------------------------------
  //
  // Most of the Docusaurus tree carries it. The closing `---` under a `title:`
  // line is a setext heading to any parser that has not skipped the block, so
  // an unskipped one publishes an anchor nothing renders — which is a *silent*
  // loosening, not a failure, hence a positive control that pins the line
  // numbers after it as well.
  const FRONT_MATTER_TREE = {
    ...CLEAN_TREE,
    "docs/about-free2z/docs/page.md": [
      "---",
      "title: A page",
      "sidebar_position: 2",
      "---",
      "",
      "# A page",
      "",
      "Anchors: [here](#a-page) and [there](#a-page-1).",
    ].join("\n"),
  };
  expectDetected(
    "an anchor that only exists if front matter is read as a heading",
    FRONT_MATTER_TREE,
    /docs\/about-free2z\/docs\/page\.md:8: "#a-page-1" points at heading anchor #a-page-1/,
    { minimumDocuments: 4 },
  );
  expectClean(
    "front matter skipped, with the line numbers after it still right",
    withFile(FRONT_MATTER_TREE, "docs/about-free2z/docs/page.md", (text) =>
      text.replace(" and [there](#a-page-1)", ""),
    ),
    { minimumDocuments: 4, minimumRelativeLinks: 7 },
  );

  // ---- site-absolute targets ---------------------------------------------
  expectClean("router-served site-absolute targets inside a registered site", CLEAN_TREE);
  expectDetected(
    "a site-absolute target in a document no router serves",
    withFile(CLEAN_TREE, "README.md", (text) =>
      text.replace("(docs/architecture.md)", "(/docs/architecture.md)"),
    ),
    /README\.md:3: "\/docs\/architecture\.md" is a site-absolute target in a document that no router serves/,
  );
  expectDetected(
    "the site exemption pointed at a root holding no Markdown",
    CLEAN_TREE,
    /SITE_ROUTE_ROOTS registers docs\/nowhere\/, which holds no tracked Markdown/,
    {
      siteRouteRoots: [
        {
          root: "docs/nowhere/",
          reason:
            "self-test: a registration for a site root that the enumeration did not produce",
        },
      ],
      minimumRelativeLinks: 0,
      minimumAnchors: 0,
      minimumDocuments: 0,
    },
  );
  expectDetected(
    "a site exemption with no substantive reason",
    CLEAN_TREE,
    /SITE_ROUTE_ROOTS has an entry \(docs\/about-free2z\/\) whose reason is 7 character\(s\)/,
    {
      siteRouteRoots: [{ root: "docs/about-free2z/", reason: "meh, ok" }],
    },
  );

  // ---- registries are self-invalidating ----------------------------------
  const ROUTER_TREE = {
    ...CLEAN_TREE,
    "docs/about-free2z/docs/guide.md": "# Guide\n\nSee [zpages](../overview/zpages).\n",
  };
  const ROUTER_ENTRY = {
    file: "docs/about-free2z/docs/guide.md",
    target: "../overview/zpages",
    reason:
      "self-test: Docusaurus resolves this by document id; there is no file at that path and " +
      "there is not meant to be",
  };
  expectDetected(
    "an extensionless router link that nobody registered",
    ROUTER_TREE,
    /docs\/about-free2z\/docs\/guide\.md:3: "\.\.\/overview\/zpages" resolves to docs\/about-free2z\/overview\/zpages/,
  );
  expectClean("a registered router-resolved link", ROUTER_TREE, {
    routerResolved: [ROUTER_ENTRY],
    minimumRelativeLinks: 7,
  });
  expectDetected(
    "a router registration whose link has been fixed",
    CLEAN_TREE,
    /ROUTER_RESOLVED_TARGETS excuses "\.\.\/overview\/zpages" in docs\/about-free2z\/docs\/guide\.md, which no longer writes it/,
    { routerResolved: [ROUTER_ENTRY] },
  );
  const BROKEN_ENTRY = {
    file: "README.md",
    target: "docs/not-yet-written.md",
    reason:
      "self-test: a link whose target is owned by somebody else and deliberately not fixed here",
  };
  expectClean(
    "a registered known-broken link",
    withFile(CLEAN_TREE, "README.md", (text) =>
      `${text}\nPending: [soon](docs/not-yet-written.md).\n`,
    ),
    { knownBroken: [BROKEN_ENTRY], minimumRelativeLinks: 7 },
  );
  expectDetected(
    "a known-broken registration for a link that has been fixed",
    CLEAN_TREE,
    /KNOWN_BROKEN_LINKS excuses "docs\/not-yet-written\.md" in README\.md, which no longer contains it/,
    { knownBroken: [BROKEN_ENTRY] },
  );

  // ---- links into a vendored submodule -----------------------------------
  //
  // `docs/DEPENDENCIES.md` links to a Cargo.toml inside `z/zcash/librustzcash`.
  // The gitlink is one tracked path standing for a whole repository, so without
  // this every such link is a false failure — and with it, a path that only
  // *resembles* one must still fail.
  const SUBMODULE_TREE = {
    ...CLEAN_TREE,
    "docs/deps.md": [
      "# Deps",
      "",
      "Pinned by [Cargo.toml](../z/zcash/librustzcash/Cargo.toml).",
    ].join("\n"),
    "z/zcash/librustzcash": "",
  };
  expectClean("a link into a vendored submodule", SUBMODULE_TREE, {
    submodules: ["z/zcash/librustzcash"],
    minimumRelativeLinks: 7,
    minimumDocuments: 4,
  });
  expectDetected(
    "a link into a path that only looks like a submodule",
    SUBMODULE_TREE,
    /docs\/deps\.md:3: "\.\.\/z\/zcash\/librustzcash\/Cargo\.toml" resolves to z\/zcash\/librustzcash\/Cargo\.toml/,
    { submodules: ["z/zcash/orchard"], minimumDocuments: 4 },
  );

  // ---- Docusaurus document ids -------------------------------------------
  //
  // Resolved, not excused: the point is that the anchor after the id gets
  // checked against the real document's headings.
  const SITE_TREE = {
    ...CLEAN_TREE,
    "docs/about-free2z/docs/getting-started/01-quickstart.md": [
      "# Quickstart",
      "",
      "Next: [zpages](./zpages#free2z-flavored-markdown-features), then",
      "[live](../for-creators/free2z-live) and [index](./index).",
    ].join("\n"),
    "docs/about-free2z/docs/getting-started/04-zpages.md": [
      "# ZPages",
      "",
      "## Free2Z flavored markdown features",
    ].join("\n"),
    "docs/about-free2z/docs/getting-started/index.md": "# Getting started\n",
    "docs/about-free2z/docs/for-creators/03-free2z-live.md": "# Live\n",
  };
  expectClean("Docusaurus ids resolved through their numeric prefixes", SITE_TREE, {
    minimumDocuments: 7,
    minimumRelativeLinks: 9,
    minimumAnchors: 5,
  });
  expectDetected(
    "an anchor reached through a Docusaurus id, whose heading was renamed",
    withFile(
      SITE_TREE,
      "docs/about-free2z/docs/getting-started/04-zpages.md",
      (text) =>
        text.replace(
          "## Free2Z flavored markdown features",
          "## Free2Z markdown features",
        ),
    ),
    /01-quickstart\.md:3: "\.\/zpages#free2z-flavored-markdown-features" points at heading anchor #free2z-flavored-markdown-features in docs\/about-free2z\/docs\/getting-started\/04-zpages\.md/,
    { minimumDocuments: 7 },
  );
  expectDetected(
    "a Docusaurus id that names no document",
    withFile(
      SITE_TREE,
      "docs/about-free2z/docs/getting-started/01-quickstart.md",
      (text) => text.replace("(./zpages#", "(./zpagez#"),
    ),
    /"\.\/zpagez#free2z-flavored-markdown-features" resolves to docs\/about-free2z\/docs\/getting-started\/zpagez/,
    { minimumDocuments: 7 },
  );
  // The id rule is confined to registered site roots: outside one, an
  // extensionless target is simply a path.
  expectDetected(
    "an extensionless target outside every site root",
    withFile(CLEAN_TREE, "README.md", (text) =>
      text.replace("(docs/architecture.md)", "(docs/architecture)"),
    ),
    /README\.md:3: "docs\/architecture" resolves to docs\/architecture, which is not a tracked file or directory/,
  );

  // ---- the vendored tree -------------------------------------------------
  expectDetected(
    "a Markdown file that appeared inside the vendored submodule tree",
    { ...CLEAN_TREE, "z/zcash/librustzcash/README.md": "# Upstream\n[x](./nope.md)\n" },
    /z\/zcash\/librustzcash\/README\.md is under z\/, the vendored submodule tree, and must not be scanned/,
  );

  // ---- the floors: a no-op checker must not be green ----------------------
  expectDetected(
    "a scan that reaches almost no documents",
    CLEAN_TREE,
    /read 3 Markdown document\(s\), below the floor of 90/,
    { minimumDocuments: 90 },
  );
  expectDetected(
    "a scan that finds almost no links",
    CLEAN_TREE,
    /judged \d+ relative link\(s\), below the floor of 400/,
    { minimumRelativeLinks: 400 },
  );
  // The sharpest one. Anchor resolution can be dropped while path resolution
  // keeps working, and neither of the other two floors would move.
  expectDetected(
    "a scan that resolves paths but no longer resolves anchors",
    CLEAN_TREE,
    /resolved \d+ heading anchor\(s\), below the floor of 200/,
    { minimumAnchors: 200 },
  );

  // ---- the slug algorithm ------------------------------------------------
  //
  // Eight headings copied verbatim out of this repository, each paired with the
  // anchor GitHub actually publishes for it. Verbatim matters: a slug rule
  // tested only against invented headings can be self-consistently wrong, and
  // the two rules most easily got wrong are both visible here — the em dash
  // leaves the two spaces that flanked it (hence `--`), and a leading emoji
  // leaves the space that followed it (hence a leading `-`).
  expectSlug("4. What enforces the boundary", "4-what-enforces-the-boundary"); // docs/architecture.md
  expectSlug(
    "7. Application framing — hash-linked causal ordering", // docs/e2ee/ARCHITECTURE.md:672
    "7-application-framing--hash-linked-causal-ordering",
  );
  expectSlug(
    "4.3 Uniqueness within an epoch — a MUST that comes from the audit", // docs/e2ee/KT.md:404
    "43-uniqueness-within-an-epoch--a-must-that-comes-from-the-audit",
  );
  expectSlug(
    "Worktree hygiene: run the audit, do not trust the habit", // AGENTS.md:405
    "worktree-hygiene-run-the-audit-do-not-trust-the-habit",
  );
  expectSlug("`rs/` — the free2z Rust workspace", "rs--the-free2z-rust-workspace"); // rs/README.md:1
  expectSlug("Verifying before you push", "verifying-before-you-push"); // AGENTS.md
  expectSlug("4.2 Derivation (proposed)", "42-derivation-proposed"); // docs/e2ee/ARCHITECTURE.md:194
  expectSlug("⭐ Star the Project", "-star-the-project"); // ts/react/free2z/README.md:9
  console.log("self-test: the GitHub slug algorithm matches on 8 verbatim headings.");

  // And one synthetic control for a character class the tree does not yet put
  // in a heading. `§` is U+00A7, inside the range GitHub's slugger strips, so a
  // future `## §4.2 Derivation` must slug the same as the numbered form above.
  expectSlug("§4.2 Derivation (proposed)", "42-derivation-proposed");

  console.log(`check-markdown-links self-test: ${cases} case(s) passed.`);
}

const mode = process.argv[2];
if (mode && mode !== "--self-test") {
  console.error("usage: node scripts/check-markdown-links.mjs [--self-test]");
  process.exit(2);
}

if (mode === "--self-test") {
  selfTest();
  process.exit(0);
}

const result = scanRepository(REPO_ROOT);
if (result.failures.length) {
  console.error("Markdown link resolution failed:");
  for (const failure of result.failures) console.error(`- ${failure}`);
  console.error(
    `${result.failures.length} failure(s) over ${result.relativeLinks} relative link(s) ` +
      `in ${result.scanned} tracked Markdown document(s).`,
  );
  process.exit(1);
}
console.log(
  `Every relative Markdown link resolves: ${result.relativeLinks} link(s) and ` +
    `${result.anchorsChecked} heading anchor(s) across ${result.scanned} tracked document(s) ` +
    `(${result.external} external URL(s) never fetched, ` +
    `${result.siteRoutes} site route(s) left to the Docusaurus build, ` +
    `${result.submoduleTargets} target(s) inside vendored submodules).`,
);
