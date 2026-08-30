/**
 * UI copy never truncates — static enforcement.
 *
 * The doctrine (see `wallet/zuuli/CLAUDE.md` → Design rules):
 *
 *   1. UI copy NEVER truncates. Layouts are designed so the words fit; if they
 *      cannot fit, the layout wraps or reflows. A CSS clip is never the answer.
 *   2. Opaque identifiers (Zcash addresses, txids, DIDs, meeting IDs) truncate
 *      in the MIDDLE, tail-weighted, through `truncateAddress()` /
 *      `truncateMiddle()` — and are rendered WITHOUT a CSS clip on top, because
 *      a second clip eats the trailing checksum characters a human verifies.
 *   3. User-authored BODY content (article excerpts, bios, system messages) may
 *      wrap and `line-clamp` — but the site must SAY SO, in the markup, with
 *      `data-user-content`.
 *
 * This scanner is deliberately fail-safe for NEW code: the ellipsis utilities
 * are banned outright, and every `line-clamp-*` must carry an explicit
 * `data-user-content` annotation on its own JSX element. Nothing is
 * grandfathered by an allowlist that a future author would have to remember to
 * update — a new violation fails on the first run.
 *
 * The runtime counterpart lives in `tests/viewport.pw.ts`, which catches
 * ellipsis that arrives through CSS rather than a utility class.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

/** Tailwind utilities that clip text with an ellipsis. Never allowed. */
const BANNED_CLIP_UTILITIES = ["truncate", "text-ellipsis", "overflow-ellipsis"];

/** Clamp utilities: allowed only on an element marked `data-user-content`. */
const CLAMP_PATTERN = /(?<![\w-])line-clamp-\d+(?![\w-])/g;

const USER_CONTENT_ATTRIBUTE = "data-user-content";

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.(tsx?|css)$/.test(entry)) out.push(full);
  }
  return out.sort();
}

/**
 * Blank out comment bodies so prose ABOUT the rule (this file, the
 * `truncateAddress` doc block) is not mistaken for markup that breaks it.
 * Offsets are preserved so reported positions stay accurate. Only block
 * comments and whole-line `//` comments are removed — a trailing `//` is left
 * alone, because a URL inside an attribute must never be able to hide the
 * `className` that follows it on the same line.
 */
function stripComments(source) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
  out = out
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? " ".repeat(line.length) : line))
    .join("\n");
  return out;
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

/**
 * The JSX opening tag that encloses `index`: from the nearest preceding `<`
 * that starts an element, to its closing `>` at brace depth zero (so `>` inside
 * a `{...}` expression, e.g. `cn("x", n > 1 && "y")`, does not end the tag).
 */
function enclosingOpeningTag(source, index) {
  let start = -1;
  for (let i = index; i >= 0; i -= 1) {
    if (source[i] === "<" && /[A-Za-z]/.test(source[i + 1] ?? "")) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let depth = 0;
  let quote = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

const FILES = sourceFiles(SRC);

const CHROME_ROOTS = [
  join(SRC, "components"),
  join(SRC, "features"),
];
const CHROME_FILES = FILES.filter(
  (file) =>
    !/\.test\.tsx?$/.test(file) &&
    CHROME_ROOTS.some((directory) => file.startsWith(`${directory}/`)),
);

/**
 * A deliberately small, high-confidence policy for implementation prose in
 * product chrome. Privacy, security, money, consent, and recovery language is
 * outside this list and remains visible.
 */
const TECHNICAL_EXPLAINERS = [
  {
    label: "names the search implementation",
    pattern: /\bsemantic(?:\s+\w+)?\s+search\b/giu,
  },
  {
    label: "explains search ranking",
    pattern:
      /\b(?:search(?:es|ing)?|results?|pages?|articles?)\b[^\n"'`]{0,90}\b(?:by\s+meaning|rank(?:ed|ing)?\s+by)\b/giu,
  },
  {
    label: "contrasts meaning with keywords",
    pattern: /\bmeaning\b[^\n"'`]{0,50}\bkeywords?\b/giu,
  },
  {
    label: "describes matching internals",
    pattern: /\b(?:creators?|pages?|articles?)\s+are\s+matched\s+by\b/giu,
  },
  {
    label: "pitches the article implementation",
    pattern: /\bbacked\s+by\s+free2z\s+zpages\b/giu,
  },
  {
    label: "exposes a server response diagnostic",
    pattern: /\bthe\s+server\s+returned\s+no\b/giu,
  },
  {
    label: "exposes the tag wire format",
    pattern: /\bserver(?:'s)?\s+comma-delimited\s+filter\b/giu,
  },
];

test("no source file ships a CSS ellipsis clip", () => {
  const violations = [];
  for (const file of FILES) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const utility of BANNED_CLIP_UTILITIES) {
      const pattern = new RegExp(`(?<![\\w-])${utility}(?![\\w-])`, "g");
      for (const match of source.matchAll(pattern)) {
        violations.push(
          `${relative(ROOT, file)}:${lineOf(source, match.index)} uses "${utility}"`,
        );
      }
    }
    for (const match of source.matchAll(/text-overflow\s*:\s*ellipsis/g)) {
      violations.push(
        `${relative(ROOT, file)}:${lineOf(source, match.index)} sets text-overflow: ellipsis`,
      );
    }
  }

  assert.deepEqual(
    violations,
    [],
    `UI copy never truncates, and identifiers truncate in the middle via truncateAddress()/truncateMiddle() — never with a CSS clip on top. Remove these:\n  ${violations.join("\n  ")}\n`,
  );
});

test("every line-clamp is annotated as user-authored content", () => {
  const violations = [];
  for (const file of FILES) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(CLAMP_PATTERN)) {
      const tag = enclosingOpeningTag(source, match.index);
      if (tag && tag.includes(USER_CONTENT_ATTRIBUTE)) continue;
      violations.push(
        `${relative(ROOT, file)}:${lineOf(source, match.index)} clamps "${match[0]}" without ${USER_CONTENT_ATTRIBUTE}`,
      );
    }
  }

  assert.deepEqual(
    violations,
    [],
    `line-clamp is reserved for user-authored body content, and the markup must say so. Add ${USER_CONTENT_ATTRIBUTE} to the clamped element — or, if it is UI copy, let it wrap:\n  ${violations.join("\n  ")}\n`,
  );
});

test("product chrome contains no Search implementation explainer", () => {
  const violations = [];
  for (const file of CHROME_FILES) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const rule of TECHNICAL_EXPLAINERS) {
      rule.pattern.lastIndex = 0;
      for (const match of source.matchAll(rule.pattern)) {
        violations.push(
          `${relative(ROOT, file)}:${lineOf(source, match.index)} ${rule.label}: ${JSON.stringify(match[0])}`,
        );
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Move implementation detail to source comments or logs; keep product chrome to actions and states:\n  ${violations.join("\n  ")}\n`,
  );
});

test("the source audit recognizes the reported phrase and close rewrites", () => {
  const fixtures = [
    "Semantic search",
    "semantic page search",
    "Search articles by meaning",
    "Results ranked by meaning",
    "meaning, not just keywords",
    "Creators are matched by username",
    "backed by free2z zpages",
    "The server returned no article",
    "the server's comma-delimited filter",
  ];

  for (const fixture of fixtures) {
    assert.ok(
      TECHNICAL_EXPLAINERS.some((rule) => {
        rule.pattern.lastIndex = 0;
        return rule.pattern.test(fixture);
      }),
      `audit fixture was not recognized: ${fixture}`,
    );
  }
});
