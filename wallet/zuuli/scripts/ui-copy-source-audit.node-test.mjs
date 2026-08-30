/**
 * Keep implementation notes out of product chrome.
 *
 * This is intentionally a small, high-confidence policy. It rejects the
 * reported Search explainer and close rewrites without treating necessary
 * privacy, security, money, consent, or recovery language as technical noise.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHROME_ROOTS = [
  join(ROOT, "src", "components"),
  join(ROOT, "src", "features"),
];

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

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      files.push(path);
    }
  }
  return files.sort();
}

function stripComments(source) {
  let result = source.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
  result = result
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? " ".repeat(line.length) : line))
    .join("\n");
  return result;
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

test("product chrome contains no Search implementation explainer", () => {
  const violations = [];
  for (const file of CHROME_ROOTS.flatMap(sourceFiles)) {
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
