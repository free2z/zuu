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
// Two further properties are checked, because a gate can be perfectly wired to
// the jobs it awaits and still not be the verdict branch protection thinks it
// is:
//
//   3. UNIQUE CONTEXT. A job publishes its check-run name — `name:` when
//      present, otherwise the job id — and branch protection matches required
//      checks by that name. GitHub's own documentation says to "make sure that
//      job names are unique across all workflows. Using the same job name in
//      multiple workflows can cause ambiguous status check results and block
//      pull requests from being merged." Two workflows answering to one name
//      makes which run satisfies the context a function of report order rather
//      than policy, so this rejects duplicates across the whole tree.
//
//   4. TOTAL COVERAGE. A gate's `needs:` must cover every job in its own file.
//      The wiring rules above only prove `needs` / `env:` / `results=` agree
//      *with each other*; a job added to the file and never added to `needs`
//      satisfies all three and is invisible to the gate. That is the likeliest
//      future regression, so `needs ⊇ {jobs in file} − {gate}` is asserted,
//      with an explicit per-file opt-out for jobs deliberately left outside.
//
//   5. PROTECTED AND EXPECTED CONTEXTS. Each branch-protected name must have one
//      producer, five ambiguity fixes retain their exact reviewed display names,
//      and the collision allowlist remains empty. The production configuration
//      is digest-pinned independently from the workflows and fixture options.
//
// Usage:
//   node scripts/check-workflow-gates.mjs             judge every workflow
//   node scripts/check-workflow-gates.mjs --self-test negative controls first

import { createHash } from "node:crypto";
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

/// The check-run names branch protection requires on `main`. Source of truth:
///
///   gh api repos/free2z/zuu/branches/main/protection/required_status_checks \
///     --jq '{contexts,strict}'
///   {"contexts":["gate","rs / gate"],"strict":true}
///
/// These are the contexts that can decide a merge, which makes them different in
/// kind from every other name in the tree, in two directions:
///
///   * A collision on one of them is exactly the #562 defect — two producers
///     means the required check resolves by report order rather than by policy —
///     so it can never be tolerated. `TOLERATED_CONTEXT_COLLISIONS` may not
///     contain any of these names, and saying so makes the *allowlist edit*
///     fail rather than the `name:` removal that would follow it.
///
///   * The reverse drift is just as bad and quieter: a required context that no
///     job publishes never reports, so every PR waits on it forever. Nothing in
///     the tree goes red — the check simply sits pending — and the first person
///     to notice is whoever tries to merge. So each of these must be published
///     by exactly one job.
///
/// The second rule assumes every required context comes from a job in this
/// repository's `.github/workflows`, which is true today: both are Actions
/// check runs from `zuuli.yml` and `rs.yml`. If branch protection ever requires
/// a context from something this script cannot see — a third-party app, or a
/// workflow living in another repository — that entry does not belong in this
/// set, and the comment here is the place to record why.
const PROTECTED_CONTEXTS = new Set(["gate", "rs / gate"]);

/// Exact display contexts introduced by #567. These are a reviewed contract,
/// not values derived from the workflow files under test: otherwise deleting a
/// `name:` line would merely change both the input and its expected value.
const EXPECTED_JOB_CONTEXTS = new Map([
  [".github/workflows/docs-about-free2z.yml#build", "docs / build"],
  [".github/workflows/ts-react-free2z.yml#build", "ts-react / build"],
  [".github/workflows/ts-svelte-free2z.yml#build", "ts-svelte / build"],
  [".github/workflows/zuuallet.yml#frontend", "zuuallet / frontend"],
  [".github/workflows/zuuli.yml#frontend", "zuuli / frontend"],
]);

/// Independently reviewed digest of the protected-context set and exact job
/// context registry above. A change to either contract must update this second
/// value deliberately; narrowing the expected set cannot make its own mutation
/// tests disappear silently.
const REQUIRED_CONTEXT_POLICY_DIGEST =
  "cec99799db16a0b05e67a22359e9c69ed0707616ba7bbee34c4deb7cb33f3120";

/// Retained as an explicit empty configuration so a future attempt to restore
/// an exception has a direct red control. Duplicated contexts are no longer
/// tolerable, protected or otherwise.
const TOLERATED_CONTEXT_COLLISIONS = new Map();

/// Jobs a gate is deliberately not required to await, per workflow file.
///
/// Empty on purpose: today both gates await every job in their own file, so
/// nothing needs excusing. It exists because the excuse must be written down
/// next to the rule when one is eventually needed — a scheduled canary that is
/// not part of a PR verdict is the foreseeable case — rather than the rule
/// being weakened to accommodate it. The self-test exercises this path with an
/// injected map so the opt-out is not untested code.
const GATE_EXEMPT_JOBS = new Map();

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

/// The check-run name a job publishes, which is what branch protection matches
/// a required context against: the job's `name:` when it declares one, and the
/// job id otherwise.
///
/// Conservative about matrix jobs on purpose. A job with a `strategy.matrix`
/// publishes `<name> (<values>)` per leg, so two files sharing a base name are
/// not literally the same context — but the resolution is still to give them
/// distinct names, so the base name is what is compared.
function publishedContext(lines, job) {
  for (let index = job.start + 1; index < job.end; index += 1) {
    const line = lines[index];
    if (isBlank(line)) continue;
    if (indentOf(line) <= 2) break;
    if (indentOf(line) !== 4) continue;
    const match = /^ {4}name:\s*(.+?)\s*$/.exec(line);
    if (match) return match[1].replace(/^['"]|['"]$/g, "");
  }
  return job.name;
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
///
/// `siblings` is every job id defined in the same file, and `exempt` the ids
/// that file is allowed to leave outside the gate.
export function gateFailures(
  relativeFile,
  lines,
  job,
  siblings = [],
  exempt = new Set(),
) {
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

  // Coverage. Wiring the three sets to each other proves nothing about a job
  // that was never wired at all, so require the gate to await every job its own
  // workflow defines.
  const unawaited = difference(
    difference(new Set(siblings.filter((id) => id !== job.name)), exempt),
    awaited,
  );
  if (unawaited.size) {
    failures.push(
      `${relativeFile}:${needs.index + 1}: gate does not await ${sorted(unawaited)}, ` +
        "defined in the same workflow; a job outside the gate's needs is a job the gate cannot fail on",
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

export function contextPolicyIdentity(protectedContexts, expectedContexts) {
  return [
    ...[...protectedContexts]
      .sort()
      .map((context) => `protected\0${context}`),
    ...[...expectedContexts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([producer, context]) => `expected\0${producer}\0${context}`),
  ].join("\n");
}

/// Pin the production configuration separately from the workflow scan. The
/// self-test fixtures inject their own miniature contracts, so without this
/// control deleting the real protected/expected set would leave every fixture
/// green while silently blinding the live check.
export function productionContextConfigurationFailures(
  protectedContexts = PROTECTED_CONTEXTS,
  expectedContexts = EXPECTED_JOB_CONTEXTS,
  tolerated = TOLERATED_CONTEXT_COLLISIONS,
) {
  const failures = [];
  if (tolerated.size !== 0) {
    failures.push(
      `TOLERATED_CONTEXT_COLLISIONS must remain empty, got ${tolerated.size} entr${tolerated.size === 1 ? "y" : "ies"}; give every producer a unique name instead`,
    );
  }
  const digest = createHash("sha256")
    .update(contextPolicyIdentity(protectedContexts, expectedContexts))
    .digest("hex");
  if (digest !== REQUIRED_CONTEXT_POLICY_DIGEST) {
    failures.push(
      `protected and expected status-check contexts differ from the independently reviewed registry digest: ${digest}`,
    );
  }
  return failures;
}

/// Require the reviewed file#job producers to publish their exact display
/// contexts. This complements global uniqueness: after all five collisions are
/// fixed, deleting any one name leaves its fallback job id globally unique, so
/// collision detection alone cannot prove that line remains present.
export function expectedContextFailures(published, expectedContexts) {
  const failures = [];
  const byProducer = new Map(
    published.map((entry) => [`${entry.file}#${entry.job}`, entry.context]),
  );
  for (const [producer, expected] of expectedContexts) {
    const actual = byProducer.get(producer);
    if (actual === expected) continue;
    failures.push(
      `${producer} must publish the exact status-check context ${JSON.stringify(expected)}, got ${actual === undefined ? "no job" : JSON.stringify(actual)}`,
    );
  }
  return failures;
}

/// Reject two workflows answering to one check-run name.
///
/// Branch protection resolves a required context by name, so a duplicated name
/// makes *which* run satisfies the context a function of report order. There is
/// no exception path: every duplicate fails.
///
/// Triggers are deliberately not consulted. A name that is unique only because
/// the two workflows happen to run on different events stops being unique the
/// moment someone adds `pull_request:` to one of them, which is a one-line edit
/// nobody would think of as touching branch protection.
export function contextCollisionFailures(published) {
  const failures = [];
  const byContext = new Map();
  for (const entry of published) {
    if (!byContext.has(entry.context)) byContext.set(entry.context, []);
    byContext.get(entry.context).push(entry);
  }
  for (const [context, entries] of [...byContext].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (entries.length < 2) continue;
    const producers = [...new Set(entries.map((entry) => entry.file))].sort();
    failures.push(
      `${producers.join(", ")}: ${entries.length} job(s) publish the status-check context "${context}" ` +
        `(${entries.map((entry) => `${entry.file}#${entry.job}`).join(", ")}); ` +
        "branch protection matches contexts by name, so a duplicate resolves by report order rather than policy",
    );
  }
  return failures;
}

/// Require each protected context to be published by exactly one job.
///
/// The zero case is the silent one — branch protection waiting on a name no job
/// emits blocks every PR with nothing to look at — and it is what a rename of a
/// gate job without the matching branch-protection update looks like. The
/// many case is already reported as a collision; it is repeated here because
/// "exactly one" is the property being asserted, and a required context with two
/// producers is worth saying twice.
export function protectedProducerFailures(published, protectedContexts) {
  const failures = [];
  for (const context of [...protectedContexts].sort()) {
    const producers = published.filter((entry) => entry.context === context);
    if (producers.length === 1) continue;
    if (producers.length === 0) {
      failures.push(
        `branch protection requires the status-check context "${context}", which no job publishes; ` +
          "a required context nothing reports leaves every pull request pending forever " +
          "(fix the job's name: or update PROTECTED_CONTEXTS to match branch protection)",
      );
      continue;
    }
    failures.push(
      `branch protection requires the status-check context "${context}", which ${producers.length} jobs publish ` +
        `(${producers.map((entry) => `${entry.file}#${entry.job}`).join(", ")}); ` +
        "a required context must have exactly one producer",
    );
  }
  return failures;
}

export function scanRepository(root, options = {}) {
  const protectedContexts = options.protectedContexts ?? PROTECTED_CONTEXTS;
  const expectedContexts = options.expectedContexts ?? EXPECTED_JOB_CONTEXTS;
  const tolerated = options.tolerated ?? TOLERATED_CONTEXT_COLLISIONS;
  const enforceProductionConfiguration =
    options.enforceProductionConfiguration ?? true;
  const exemptions = options.exempt ?? GATE_EXEMPT_JOBS;
  const failures = [];
  const published = [];
  let gates = 0;
  const files = workflowFiles(root);
  for (const file of files) {
    const relativeFile = path
      .relative(root, file)
      .split(path.sep)
      .join("/");
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const jobs = jobsIn(lines);
    const siblings = jobs.map((job) => job.name);
    const exempt = new Set(exemptions.get(relativeFile) ?? []);
    for (const job of jobs) {
      published.push({
        file: relativeFile,
        job: job.name,
        context: publishedContext(lines, job),
      });
      if (job.name !== "gate") continue;
      gates += 1;
      failures.push(...gateFailures(relativeFile, lines, job, siblings, exempt));
    }
  }
  if (enforceProductionConfiguration) {
    failures.push(
      ...productionContextConfigurationFailures(
        protectedContexts,
        expectedContexts,
        tolerated,
      ),
    );
  }
  failures.push(...expectedContextFailures(published, expectedContexts));
  failures.push(...contextCollisionFailures(published));
  failures.push(...protectedProducerFailures(published, protectedContexts));
  return { failures, gates, files: files.length, contexts: published.length };
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

/// The same workflow as EXPLICIT_GATE, with every job carrying a display name.
/// Its purpose is to be a second file in the tree that does *not* collide, which
/// is what proves the collision detection reads `name:` and not the file count.
const NAMED_GATE = `name: other fixture

on:
  pull_request:

jobs:
  changes:
    name: other / changes
    runs-on: ubuntu-latest
    outputs:
      selected: \${{ steps.filter.outputs.selected }}
    steps:
      - run: echo selected=true >> "$GITHUB_OUTPUT"

  alpha:
    name: other / alpha
    needs: changes
    runs-on: ubuntu-latest
    steps:
      - run: echo alpha

  gate:
    name: other / gate
    needs: [changes, alpha]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Verify required jobs succeeded or legitimately skipped
        env:
          CHANGES: \${{ needs.changes.result }}
          ALPHA: \${{ needs.alpha.result }}
        run: |
          results="alpha=$ALPHA"
          echo "$results"
`;

/// An extra job in the same file as a gate that never awaits it.
const UNAWAITED_JOB = `  gamma:
    needs: changes
    runs-on: ubuntu-latest
    steps:
      - run: echo gamma

  gate:`;

/// `contents` is either one workflow's text, written as `fixture.yml`, or a
/// `{ filename: text }` map when a case needs more than one workflow in a tree.
function withFixture(contents, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zuu-gate-self-test-"));
  try {
    const directory = path.join(root, ".github", "workflows");
    fs.mkdirSync(directory, { recursive: true });
    const files =
      typeof contents === "string" ? { "fixture.yml": contents } : contents;
    for (const [name, text] of Object.entries(files)) {
      fs.writeFileSync(path.join(directory, name), text);
    }
    return body(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/// Fixtures are judged against fixture configuration, never the repository's
/// live constants: the fixtures publish `gate` and not `rs / gate`, and do not
/// contain the five production display-name contracts. `gate` is protected
/// unless a case says otherwise, so the exactly-one-producer rule is exercised
/// by every case and not only by its own.
function fixtureOptions(options) {
  return {
    protectedContexts: new Set(["gate"]),
    expectedContexts: new Map(),
    enforceProductionConfiguration: false,
    ...options,
  };
}

function expectClean(label, contents, options = {}) {
  const { gates = 1, ...scan } = fixtureOptions(options);
  const result = withFixture(contents, (root) => scanRepository(root, scan));
  if (result.gates !== gates) {
    throw new Error(
      `self-test FAILED: ${label} presented ${result.gates} gate(s), expected ${gates}`,
    );
  }
  if (result.failures.length) {
    throw new Error(
      `self-test FAILED: ${label} should pass, got: ${result.failures.join("; ")}`,
    );
  }
  console.log(`self-test: ${label} passes.`);
}

function expectDetected(label, contents, pattern, options = {}) {
  const result = withFixture(contents, (root) =>
    scanRepository(root, fixtureOptions(options)),
  );
  const joined = result.failures.join("; ");
  if (!pattern.test(joined)) {
    throw new Error(
      `self-test FAILED: ${label} was not detected. Failures: ${joined || "(none)"}`,
    );
  }
  console.log(`self-test: ${label} is detected.`);
}

function expectConfigurationDetected(label, overrides, pattern) {
  const failures = productionContextConfigurationFailures(
    overrides.protectedContexts ?? PROTECTED_CONTEXTS,
    overrides.expectedContexts ?? EXPECTED_JOB_CONTEXTS,
    overrides.tolerated ?? TOLERATED_CONTEXT_COLLISIONS,
  );
  const joined = failures.join("; ");
  if (!pattern.test(joined)) {
    throw new Error(
      `self-test FAILED: ${label} was not detected. Failures: ${joined || "(none)"}`,
    );
  }
  console.log(`self-test: ${label} is detected.`);
}

function selfTest() {
  const productionConfigurationFailures =
    productionContextConfigurationFailures();
  if (productionConfigurationFailures.length) {
    throw new Error(
      `self-test FAILED: production context configuration is not a valid mutation base: ${productionConfigurationFailures.join("; ")}`,
    );
  }
  console.log("self-test: production context configuration passes.");

  // Exercise the production-configuration verdict through the live repository
  // scan, rather than only testing the helper in isolation. Deleting or
  // hard-coding that scan invocation must make this deliberately incomplete
  // protected-context policy disappear and therefore fail the assertion.
  const invalidProductionScan = scanRepository(REPO_ROOT, {
    protectedContexts: new Set(["gate"]),
  });
  const productionScanDiagnostic =
    /protected and expected status-check contexts differ from the independently reviewed registry digest/;
  if (
    !invalidProductionScan.failures.some((failure) =>
      productionScanDiagnostic.test(failure),
    )
  ) {
    throw new Error(
      `self-test FAILED: the live repository scan did not enforce its injected production context configuration. Failures: ${invalidProductionScan.failures.join("; ") || "(none)"}`,
    );
  }
  console.log(
    "self-test: the live repository scan enforces injected production context configuration.",
  );

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

  // Coverage: a job the gate never awaits. It is well-formed and would run on
  // every PR; the gate simply has no opinion about how it concluded.
  expectDetected(
    "a job in the file that the gate does not await",
    EXPLICIT_GATE.replace("  gate:", UNAWAITED_JOB),
    /gate does not await gamma, defined in the same workflow/,
  );
  // And the opt-out actually excuses it, which is the only way to know the
  // escape hatch works before someone needs it under pressure.
  expectClean(
    "a job excused by the per-file opt-out",
    EXPLICIT_GATE.replace("  gate:", UNAWAITED_JOB),
    { exempt: new Map([[".github/workflows/fixture.yml", ["gamma"]]]) },
  );

  // Unique contexts: two workflows answering to one name. Both fixtures are
  // individually well-formed gates, so nothing but the duplicate name differs.
  expectDetected(
    "two workflows publishing the same status-check context",
    { "fixture.yml": EXPLICIT_GATE, "other.yml": EXPLICIT_GATE },
    /2 job\(s\) publish the status-check context "gate"/,
  );
  expectClean(
    "two gates in one tree with distinct display names",
    { "fixture.yml": EXPLICIT_GATE, "other.yml": NAMED_GATE },
    { gates: 2 },
  );
  expectDetected(
    "a third producer of a duplicate context",
    {
      "fixture.yml": EXPLICIT_GATE,
      "other.yml": EXPLICIT_GATE,
      "third.yml": EXPLICIT_GATE,
    },
    /3 job\(s\) publish the status-check context "gate"/,
  );

  // Production configuration is independently pinned. Fixture self-tests use
  // injected miniature sets, so mutate the real sets here as their own guards.
  expectConfigurationDetected(
    "a nonempty tolerated-collision map",
    {
      tolerated: new Map([
        [
          "build",
          [".github/workflows/one.yml", ".github/workflows/two.yml"],
        ],
      ]),
    },
    /TOLERATED_CONTEXT_COLLISIONS must remain empty/,
  );
  expectConfigurationDetected(
    "the production protected-context set is emptied",
    {
      protectedContexts: new Set(),
    },
    /differ from the independently reviewed registry digest/,
  );
  expectConfigurationDetected(
    "the production expected-context registry is emptied",
    {
      expectedContexts: new Map(),
    },
    /differ from the independently reviewed registry digest/,
  );

  // Exercise the actual five live workflow contracts, with expectations read
  // only from the independent registry above. Global collision detection is
  // insufficient here: deleting one of the now-unique names leaves its fallback
  // job id unique, so both deletion and alteration need their own red controls.
  const currentWorkflows = Object.fromEntries(
    workflowFiles(REPO_ROOT).map((file) => [
      path.basename(file),
      fs.readFileSync(file, "utf8"),
    ]),
  );
  for (const [producer, expected] of EXPECTED_JOB_CONTEXTS) {
    const [relativeFile] = producer.split("#");
    const filename = path.basename(relativeFile);
    const source = currentWorkflows[filename];
    const needle = `    name: ${expected}\n`;
    const occurrences = source?.split(needle).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `self-test FAILED: ${producer} expected exactly one ${JSON.stringify(needle)}, got ${occurrences}`,
      );
    }
    for (const [mutation, replacement] of [
      ["deletion", ""],
      ["alteration", `    name: ${expected} mutant\n`],
    ]) {
      const contents = {
        ...currentWorkflows,
        [filename]: source.replace(needle, replacement),
      };
      const result = withFixture(contents, (root) => scanRepository(root));
      const diagnostic = `${producer} must publish the exact status-check context`;
      if (!result.failures.some((failure) => failure.includes(diagnostic))) {
        throw new Error(
          `self-test FAILED: ${producer} name ${mutation} was not detected. Failures: ${result.failures.join("; ") || "(none)"}`,
        );
      }
      console.log(
        `self-test: ${producer} name ${mutation} is detected.`,
      );
    }
  }

  // The reverse drift: branch protection requiring a name no job publishes.
  // Both fixtures are well-formed, and with both names protected the tree is
  // clean; dropping the gate's display name is the rs.yml mutation in miniature.
  expectClean(
    "two protected contexts, each published by exactly one job",
    { "fixture.yml": EXPLICIT_GATE, "other.yml": NAMED_GATE },
    { gates: 2, protectedContexts: new Set(["gate", "other / gate"]) },
  );
  expectDetected(
    "a protected context that no job publishes",
    {
      "fixture.yml": EXPLICIT_GATE,
      "other.yml": NAMED_GATE.replace("    name: other / gate\n", ""),
    },
    /requires the status-check context "other \/ gate", which no job publishes/,
    { protectedContexts: new Set(["gate", "other / gate"]) },
  );
  expectDetected(
    "a protected context published by two jobs",
    { "fixture.yml": EXPLICIT_GATE, "other.yml": EXPLICIT_GATE },
    /requires the status-check context "gate", which 2 jobs publish/,
  );

  console.log("check-workflow-gates self-test: 33 case(s) passed.");
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
  `Every gate inspects every job it awaits and covers every job in its file, ` +
    `no two workflows publish one status-check context, and each protected context ` +
    `(${[...PROTECTED_CONTEXTS].sort().join(", ")}) has exactly one producer and no allowlist entry: ` +
    `${result.gates} gate(s), ${result.contexts} job(s), ${result.files} workflow file(s).`,
);
