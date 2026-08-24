#!/usr/bin/env node
//
// Prove that every required `gate` job actually *inspects* every job it awaits.
//
// A gate that lists a job in `needs:` and then never looks at that job's result
// is decorative for that job: GitHub will wait for it, the gate will go green
// whatever it concluded, and branch protection will report a passing required
// check over a failed build. The failure mode is silent and it looks exactly
// like success, which is why it is worth a script rather than a comment.
//
// Two idioms satisfy the rule, and this repository uses both:
//
//   1. EXPLICIT. Each awaited job is bound into the gate's environment as
//      `${{ needs.<job>.result }}` and named again in the shell that decides
//      the verdict — the `results=` line. Both sets must equal the `needs:` set
//      exactly: a job bound but never reported is not inspected, and a name
//      reported but never awaited is a typo that inspects nothing.
//      `.github/workflows/rs.yml` is this shape.
//
//   2. EXHAUSTIVE. The gate binds `${{ toJSON(needs) }}` and hands the whole
//      object to a verifier that iterates every entry. Then no per-job wiring
//      exists to drift, because there is no per-job wiring.
//      `.github/workflows/zuuli.yml` is this shape, via
//      `scripts/check-github-actions-pins.mjs --verify-gate-results`.
//
// The honest limit, stated rather than papered over: for an exhaustive gate this
// script proves the *whole* needs object reaches a verifier from the recognized
// list below. It does not read that verifier and prove it loops. Extending the
// list is therefore a deliberate act, and EXHAUSTIVE_VERIFIERS is short on
// purpose.
//
// Usage:
//   node scripts/check-workflow-gates.mjs             judge every workflow
//   node scripts/check-workflow-gates.mjs --self-test negative controls first

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/// The job every gate awaits and that is never one of the jobs under judgement:
/// its outputs are what the gate uses to decide what the others *should* have
/// concluded, so it is inspected by a different mechanism.
const CHANGE_DETECTOR = "changes";

/// Commands that consume `toJSON(needs)` by iterating every entry. Each has been
/// read and does. Adding one means reading the new verifier first.
const EXHAUSTIVE_VERIFIERS = ["--verify-gate-results"];

const NEEDS_RESULT = /needs\.([A-Za-z0-9_-]+)\.result/g;
const TO_JSON_NEEDS = /toJSON\(\s*needs\s*\)/;

function workflowFiles(root) {
  const directory = path.join(root, ".github", "workflows");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => path.join(directory, name));
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isBlank(line) {
  return !line.trim() || line.trimStart().startsWith("#");
}

/// Split a workflow into `{ name, start, end }` for every job under `jobs:`.
///
/// Line-oriented rather than YAML-parsed, matching the other check scripts in
/// this repository: the alternative is a dependency, and workflows here are
/// written in a plain, indented subset that this reads exactly.
function jobsIn(lines) {
  const jobs = [];
  let inJobs = false;
  let current = null;
  for (const [index, line] of lines.entries()) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (isBlank(line)) continue;
    if (indentOf(line) === 0) {
      // A new top-level key ends the jobs mapping.
      if (current) current.end = index;
      current = null;
      inJobs = false;
      continue;
    }
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match && indentOf(line) === 2) {
      if (current) current.end = index;
      current = { name: match[1], start: index, end: lines.length };
      jobs.push(current);
    }
  }
  if (current) current.end = lines.length;
  return jobs;
}

/// The job ids in a job's `needs:`, in any of the three shapes GitHub accepts.
function parseNeeds(lines, job) {
  for (let index = job.start + 1; index < job.end; index += 1) {
    const line = lines[index];
    if (isBlank(line)) continue;
    if (indentOf(line) <= 2) break;
    if (indentOf(line) !== 4) continue;
    const match = /^ {4}needs:\s*(.*)$/.exec(line);
    if (!match) continue;

    const inline = match[1].trim();
    if (inline.startsWith("[")) {
      let text = inline;
      let cursor = index;
      while (!text.includes("]") && cursor + 1 < job.end) {
        cursor += 1;
        text += ` ${lines[cursor].trim()}`;
      }
      const body = text.slice(text.indexOf("[") + 1, text.lastIndexOf("]"));
      return {
        index,
        values: body
          .split(",")
          .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean),
      };
    }
    if (inline) {
      return { index, values: [inline.replace(/^['"]|['"]$/g, "")] };
    }
    // Block sequence.
    const values = [];
    for (let cursor = index + 1; cursor < job.end; cursor += 1) {
      const entry = lines[cursor];
      if (isBlank(entry)) continue;
      const item = /^ {6}-\s*(.+?)\s*$/.exec(entry);
      if (!item) break;
      values.push(item[1].replace(/^['"]|['"]$/g, ""));
    }
    return { index, values };
  }
  return null;
}

/// Job names bound as `${{ needs.<job>.result }}` anywhere in the gate.
function boundResults(body) {
  const names = new Set();
  for (const match of body.matchAll(NEEDS_RESULT)) names.add(match[1]);
  return names;
}

/// Job names named on a `results=` line — the shell that renders the verdict.
///
/// Everything after the first `results=` on the line is scanned for `<name>=`
/// tokens, so the assignment's own left-hand side is not mistaken for a job.
function reportedResults(bodyLines) {
  const names = new Set();
  for (const line of bodyLines) {
    const at = line.indexOf("results=");
    if (at === -1) continue;
    const tail = line.slice(at + "results=".length);
    for (const match of tail.matchAll(/([A-Za-z0-9_-]+)=/g)) names.add(match[1]);
  }
  return names;
}

function sorted(set) {
  return [...set].sort().join(", ") || "(none)";
}

function difference(left, right) {
  return new Set([...left].filter((value) => !right.has(value)));
}

/// Judge one `gate` job. Returns an array of human-readable failures.
export function gateFailures(relativeFile, lines, job) {
  const failures = [];
  const needs = parseNeeds(lines, job);
  if (!needs) {
    return [`${relativeFile}:${job.start + 1}: gate declares no needs`];
  }

  const awaited = new Set(needs.values);
  if (!awaited.has(CHANGE_DETECTOR)) {
    failures.push(
      `${relativeFile}:${needs.index + 1}: gate must await ${CHANGE_DETECTOR}`,
    );
  }
  const judged = difference(awaited, new Set([CHANGE_DETECTOR]));
  if (judged.size === 0) {
    failures.push(
      `${relativeFile}:${needs.index + 1}: gate awaits nothing but ${CHANGE_DETECTOR}; it cannot gate anything`,
    );
    return failures;
  }

  const bodyLines = lines.slice(job.start, job.end);
  const body = bodyLines.join("\n");

  if (TO_JSON_NEEDS.test(body)) {
    const verifier = EXHAUSTIVE_VERIFIERS.find((command) =>
      body.includes(command),
    );
    if (verifier) {
      return failures;
    }
    failures.push(
      `${relativeFile}:${job.start + 1}: gate binds toJSON(needs) but runs no recognized exhaustive verifier ` +
        `(one of: ${EXHAUSTIVE_VERIFIERS.join(", ")}); an unread needs object inspects nothing`,
    );
    return failures;
  }

  const bound = difference(boundResults(body), new Set([CHANGE_DETECTOR]));
  const reported = difference(
    reportedResults(bodyLines),
    new Set([CHANGE_DETECTOR]),
  );

  const unbound = difference(judged, bound);
  if (unbound.size) {
    failures.push(
      `${relativeFile}:${job.start + 1}: gate awaits ${sorted(unbound)} without binding needs.<job>.result; ` +
        "the gate is decorative for those jobs",
    );
  }
  const strayBound = difference(bound, judged);
  if (strayBound.size) {
    failures.push(
      `${relativeFile}:${job.start + 1}: gate binds needs.<job>.result for ${sorted(strayBound)}, which it does not await`,
    );
  }
  const unreported = difference(judged, reported);
  if (unreported.size) {
    failures.push(
      `${relativeFile}:${job.start + 1}: gate awaits ${sorted(unreported)} but never names them on its results= line; ` +
        "a bound value nobody compares is not an inspection",
    );
  }
  const strayReported = difference(reported, judged);
  if (strayReported.size) {
    failures.push(
      `${relativeFile}:${job.start + 1}: gate reports ${sorted(strayReported)} on its results= line, which it does not await`,
    );
  }
  return failures;
}

export function scanRepository(root) {
  const failures = [];
  let gates = 0;
  const files = workflowFiles(root);
  for (const file of files) {
    const relativeFile = path
      .relative(root, file)
      .split(path.sep)
      .join("/");
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const job of jobsIn(lines)) {
      if (job.name !== "gate") continue;
      gates += 1;
      failures.push(...gateFailures(relativeFile, lines, job));
    }
  }
  return { failures, gates, files: files.length };
}

// ---------------------------------------------------------------------------
// Self-test. A check nobody has watched fail is not a check.
// ---------------------------------------------------------------------------

const EXPLICIT_GATE = `name: fixture

on:
  pull_request:

jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      selected: \${{ steps.filter.outputs.selected }}
    steps:
      - run: echo selected=true >> "$GITHUB_OUTPUT"

  alpha:
    needs: changes
    runs-on: ubuntu-latest
    steps:
      - run: echo alpha

  beta:
    needs: changes
    runs-on: ubuntu-latest
    steps:
      - run: echo beta

  gate:
    needs: [changes, alpha, beta]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Verify required jobs succeeded or legitimately skipped
        env:
          CHANGES: \${{ needs.changes.result }}
          ALPHA: \${{ needs.alpha.result }}
          BETA: \${{ needs.beta.result }}
        run: |
          results="alpha=$ALPHA beta=$BETA"
          echo "$results"
`;

const EXHAUSTIVE_GATE = `name: fixture

on:
  pull_request:

jobs:
  changes:
    runs-on: ubuntu-latest
    steps:
      - run: echo changes

  alpha:
    needs: changes
    runs-on: ubuntu-latest
    steps:
      - run: echo alpha

  gate:
    needs: [changes, alpha]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Verify required jobs succeeded or legitimately skipped
        env:
          REQUIRED_JOBS_JSON: \${{ toJSON(needs) }}
        run: node scripts/check-github-actions-pins.mjs --verify-gate-results
`;

function withFixture(contents, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zuu-gate-self-test-"));
  try {
    const directory = path.join(root, ".github", "workflows");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "fixture.yml"), contents);
    return body(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function expectClean(label, contents) {
  const result = withFixture(contents, (root) => scanRepository(root));
  if (result.gates !== 1) {
    throw new Error(`self-test FAILED: ${label} did not present exactly one gate`);
  }
  if (result.failures.length) {
    throw new Error(
      `self-test FAILED: ${label} should pass, got: ${result.failures.join("; ")}`,
    );
  }
  console.log(`self-test: ${label} passes.`);
}

function expectDetected(label, contents, pattern) {
  const result = withFixture(contents, (root) => scanRepository(root));
  const joined = result.failures.join("; ");
  if (!pattern.test(joined)) {
    throw new Error(
      `self-test FAILED: ${label} was not detected. Failures: ${joined || "(none)"}`,
    );
  }
  console.log(`self-test: ${label} is detected.`);
}

function selfTest() {
  expectClean("an explicitly wired gate", EXPLICIT_GATE);
  expectClean("an exhaustively wired gate", EXHAUSTIVE_GATE);

  // The negative controls. Each is a one-line mutation of a fixture that
  // passes, which is the only way to know the detection is the thing detecting.
  expectDetected(
    "a job awaited but never bound",
    EXPLICIT_GATE.replace("          BETA: ${{ needs.beta.result }}\n", ""),
    /awaits beta without binding/,
  );
  expectDetected(
    "a job bound but never reported",
    EXPLICIT_GATE.replace('results="alpha=$ALPHA beta=$BETA"', 'results="alpha=$ALPHA"'),
    /awaits beta but never names them on its results= line/,
  );
  expectDetected(
    "a name reported that is not awaited",
    EXPLICIT_GATE.replace(
      'results="alpha=$ALPHA beta=$BETA"',
      'results="alpha=$ALPHA beta=$BETA gamma=$GAMMA"',
    ),
    /reports gamma on its results= line/,
  );
  expectDetected(
    "a result bound for a job that is not awaited",
    EXPLICIT_GATE.replace(
      "    needs: [changes, alpha, beta]",
      "    needs: [changes, alpha]",
    ),
    /binds needs\.<job>\.result for beta/,
  );
  expectDetected(
    "a needs object handed to nothing that reads it",
    EXHAUSTIVE_GATE.replace(
      "        run: node scripts/check-github-actions-pins.mjs --verify-gate-results",
      "        run: echo the needs object is never read",
    ),
    /runs no recognized exhaustive verifier/,
  );
  expectDetected(
    "a gate that awaits only the change detector",
    EXPLICIT_GATE.replace(
      "    needs: [changes, alpha, beta]",
      "    needs: [changes]",
    ),
    /awaits nothing but changes/,
  );
  expectDetected(
    "a gate that does not await the change detector",
    EXPLICIT_GATE.replace(
      "    needs: [changes, alpha, beta]",
      "    needs: [alpha, beta]",
    ),
    /must await changes/,
  );

  // Block-sequence `needs:` is the other shape GitHub accepts; parse it too, so
  // rewriting a gate's needs into a list cannot silently blind this check.
  expectClean(
    "a gate whose needs is a block sequence",
    EXPLICIT_GATE.replace(
      "    needs: [changes, alpha, beta]",
      "    needs:\n      - changes\n      - alpha\n      - beta",
    ),
  );

  console.log("check-workflow-gates self-test: 10 case(s) passed.");
}

const mode = process.argv[2];
if (mode && mode !== "--self-test") {
  console.error("usage: node scripts/check-workflow-gates.mjs [--self-test]");
  process.exit(2);
}

if (mode === "--self-test") {
  selfTest();
  process.exit(0);
}

const result = scanRepository(REPO_ROOT);
if (result.gates === 0) {
  console.error(
    `no job named 'gate' found in ${result.files} workflow file(s); this check has gone blind.`,
  );
  process.exit(1);
}
if (result.failures.length) {
  console.error("Required-gate wiring failed:");
  for (const failure of result.failures) console.error(`- ${failure}`);
  console.error(
    `${result.failures.length} failure(s) across ${result.gates} gate(s) in ${result.files} workflow file(s).`,
  );
  process.exit(1);
}
console.log(
  `Every gate inspects every job it awaits: ${result.gates} gate(s) across ${result.files} workflow file(s).`,
);
