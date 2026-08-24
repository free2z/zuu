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
//   5. PROTECTED CONTEXTS. The names branch protection actually requires get a
//      stricter reading of both rules above. The tolerated-collision allowlist
//      may not name one of them, so narrowing the guard to admit a duplicate
//      `gate` fails on the allowlist edit itself rather than on the `name:`
//      change that would follow it. And each required name must be published by
//      exactly one job, which catches the opposite drift: a required context no
//      workflow emits never reports at all, so PRs hang pending forever with
//      nothing anywhere going red.
//
//   6. EVERY WORKFLOW ACCOUNTED FOR. Rules 1–5 all reason *about a gate*, so a
//      workflow that has no gate presents nothing to be wrong about and passes
//      by having no surface. That is not a hypothetical: `zuuallet.yml` ran the
//      wallet plugin's Windows test suite for months with no required check
//      able to fail on it, and this script had nothing to say (#610). So the
//      population is enumerated off the filesystem and each file must either
//      publish a gate resolving to a required context or appear in
//      `UNGATED_WORKFLOWS` with a reason. A registration for a file the
//      enumeration did not produce fails, which is what makes narrowing the
//      enumeration red rather than quietly smaller.
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

/// Check-run names that more than one workflow is knowingly allowed to publish,
/// mapped to the exact set of files allowed to publish them. Every entry is a
/// documented exception, not a category: a *new* producer of one of these names
/// still fails, because the value is the full file list rather than a wildcard.
///
/// Neither name below is a required status check, so neither can currently
/// decide a merge — that is the whole reason they are tolerated rather than
/// treated as the `gate` collision was. Renaming them is a follow-up, tracked
/// in #567; adding to this map instead of fixing a collision needs the same.
///
/// "Cannot decide a merge" is not left to the reader's judgement: a key that is
/// in `PROTECTED_CONTEXTS` is rejected outright, so this map can never be used
/// to excuse the one collision that matters.
const TOLERATED_CONTEXT_COLLISIONS = new Map([
  [
    "build",
    [
      ".github/workflows/docs-about-free2z.yml",
      ".github/workflows/ts-react-free2z.yml",
      ".github/workflows/ts-svelte-free2z.yml",
    ],
  ],
  [
    "frontend",
    [".github/workflows/zuuallet.yml", ".github/workflows/zuuli.yml"],
  ],
]);

/// Jobs a gate is deliberately not required to await, per workflow file.
///
/// Empty on purpose: today both gates await every job in their own file, so
/// nothing needs excusing. It exists because the excuse must be written down
/// next to the rule when one is eventually needed — a scheduled canary that is
/// not part of a PR verdict is the foreseeable case — rather than the rule
/// being weakened to accommodate it. The self-test exercises this path with an
/// injected map so the opt-out is not untested code.
const GATE_EXEMPT_JOBS = new Map();

/// The shortest string that can pass as a recorded reason in the registry
/// below. It exists so `""` — the thing a hurried edit reaches for — is red
/// rather than a silent exemption.
const MINIMUM_REGISTRY_REASON = 40;

/// Workflows that deliberately publish no `gate`, each mapped to why not.
///
/// Every rule above this line reasons *about a gate*: it reads a `gate` job and
/// judges what that gate awaits, binds, reports and publishes. A workflow with
/// no gate therefore presents nothing to judge, and passes by having no
/// surface — which is exactly how `.github/workflows/zuuallet.yml` came to run
/// the plugin's Windows test suite with no required check able to fail on it
/// (#610). "Nothing to complain about" and "nothing is checked" produced the
/// same green.
///
/// So the population is read off the filesystem — every `.yml`/`.yaml` under
/// `.github/workflows` — and each file must either publish a gate that resolves
/// to a context branch protection requires, or appear here with a reason. Not
/// every workflow should be gated (`cache-cleanup.yml` plainly should not),
/// which is why this is a registration and not a blanket rule.
///
/// Three properties make the registration an anchor rather than a list:
///
///   * An entry naming a file the enumeration did not produce fails. That is
///     what makes narrowing `workflowFiles` red instead of quietly shrinking
///     the population — the check names what it stopped covering.
///   * An entry naming a file that has since *gained* a gate fails, so the
///     registration cannot outlive the situation that justified it.
///   * An entry with no substantive reason fails, so the escape hatch costs a
///     sentence of justification rather than a comma.
///
/// The recurring reason below deserves stating once here: GitHub does not run a
/// workflow whose `on: pull_request:` carries a `paths:` filter when a pull
/// request touches nothing matching, and a required context from a workflow
/// that did not run never reports — every pull request waits on it forever with
/// nothing anywhere going red. So "add it to branch protection" is not a
/// one-line change for any of these: it means first moving the filter into a
/// change-detector job the way `zuuli.yml` and `rs.yml` do.
const UNGATED_WORKFLOWS = new Map([
  [
    ".github/workflows/cache-cleanup.yml",
    "Maintenance only: reclaims Actions cache entries on `pull_request_target: closed`, " +
      "schedule and dispatch. It builds and tests nothing, and no event it listens for exists " +
      "while a pull request is still open, so a required context from it could never report.",
  ],
  [
    ".github/workflows/docs-about-free2z.yml",
    "Advisory build of docs/about-free2z/**, selected by an `on: pull_request: paths:` filter; " +
      "gating it means first moving that filter into a change-detector job.",
  ],
  [
    ".github/workflows/ts-react-free2z.yml",
    "Advisory build of the free2z React app, selected by an `on: pull_request: paths:` filter; " +
      "gating it means first moving that filter into a change-detector job.",
  ],
  [
    ".github/workflows/ts-svelte-free2z.yml",
    "Advisory build of the SvelteKit port of free2z, selected by an `on: pull_request: paths:` " +
      "filter; gating it means first moving that filter into a change-detector job.",
  ],
  [
    ".github/workflows/zuuallet.yml",
    "Advisory build of the Zuuallet reference wallet behind an `on: pull_request: paths:` filter. " +
      "Its jobs restate gated work: `fmt`, `deny` and `clippy` run the same scripts as zuuli.yml's " +
      "`rust_fmt`, `rust_deny` and `rust_clippy`, and the plugin's native macOS/Windows test " +
      "execution moved to zuuli.yml's gated `rust_native_tests` in #610 rather than staying here " +
      "ungated. What remains is Zuuallet-only build coverage, which cannot fail a merge and is not " +
      "claimed to.",
  ],
  [
    ".github/workflows/zuuli-linux-image.yml",
    "Builds and publishes the pinned Linux CI container image: its pull-request leg is path-filtered " +
      "and its `publish` leg only runs on main. The property that must hold for a merge — that the " +
      "required jobs consume the pinned digest — is enforced from inside the gate by " +
      "scripts/check-zuuli-linux-image.mjs.",
  ],
  [
    ".github/workflows/zuuli-packaging.yml",
    "Path-filtered Android/iOS/desktop packaging rehearsal, plus a weekly cache-free run. The Rust " +
      "and TypeScript surface it packages is gated through zuuli.yml; this workflow proves the " +
      "packaging steps, on a filter that would leave a required context pending.",
  ],
  [
    ".github/workflows/zuuli-release.yml",
    "Release pipeline: `push` to main on wallet/zuuli/release.json, plus manual dispatch. It runs " +
      "after a merge, never on the pull request that produced it, so there is no verdict to gate.",
  ],
  [
    ".github/workflows/zuuli-store-audit.yml",
    "`workflow_dispatch` only — an operator-run read-only audit of the published store listing. No " +
      "pull-request event triggers it.",
  ],
  [
    ".github/workflows/zuuli-store-publish.yml",
    "`workflow_dispatch` only — an operator-run store publication guarded by a typed confirmation " +
      "input. No pull-request event triggers it.",
  ],
  [
    ".github/workflows/zuuli-testflight-bootstrap.yml",
    "`workflow_dispatch` only — an operator-run TestFlight bootstrap against an explicit source SHA. " +
      "No pull-request event triggers it.",
  ],
  [
    ".github/workflows/zuuli-testflight-recovery.yml",
    "`workflow_dispatch` only — an operator-run TestFlight state inspection against an explicit " +
      "source SHA. No pull-request event triggers it.",
  ],
]);

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

/// Reject two workflows answering to one check-run name.
///
/// Branch protection resolves a required context by name, so a duplicated name
/// makes *which* run satisfies the context a function of report order. The
/// tolerated map is keyed by the exact file list, so a new producer of an
/// already-tolerated name still fails.
///
/// Triggers are deliberately not consulted. A name that is unique only because
/// the two workflows happen to run on different events stops being unique the
/// moment someone adds `pull_request:` to one of them, which is a one-line edit
/// nobody would think of as touching branch protection.
export function contextCollisionFailures(published, tolerated) {
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
    const allowed = tolerated.get(context);
    if (allowed && [...allowed].sort().join("\0") === producers.join("\0")) {
      continue;
    }
    failures.push(
      `${producers.join(", ")}: ${entries.length} job(s) publish the status-check context "${context}" ` +
        `(${entries.map((entry) => `${entry.file}#${entry.job}`).join(", ")}); ` +
        "branch protection matches contexts by name, so a duplicate resolves by report order rather than policy",
    );
  }
  return failures;
}

/// Reject an allowlist entry that covers a context branch protection requires.
///
/// This is a check on the checker's own configuration rather than on the tree,
/// so it fails with no workflow needing to be wrong yet. That is the point:
/// silencing the protected `gate` collision takes two edits — the allowlist
/// entry and then the `name:` removal — and this makes the first one red, so
/// the second is never reached and the tree is never briefly ambiguous.
export function protectedToleranceFailures(tolerated, protectedContexts) {
  const failures = [];
  for (const context of [...tolerated.keys()].sort()) {
    if (!protectedContexts.has(context)) continue;
    failures.push(
      `TOLERATED_CONTEXT_COLLISIONS names "${context}", which branch protection requires: ` +
        "a duplicate producer of a required context resolves by report order rather than policy, " +
        "so it can never be tolerated — remove the entry and give the colliding job a distinct name:",
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

/// Require every workflow in the tree to be either gate-bearing or registered.
///
/// `gateContexts` maps each enumerated workflow to the check-run names its
/// `gate` job(s) publish — empty for a workflow that has no gate at all. That
/// distinction is the whole point: the rules above can only speak about a gate
/// they can see, so a file with none is invisible to them and this is the only
/// place it can be reached.
///
/// Four failures, and the last two are what keep the registry honest rather
/// than merely present:
///
///   1. A workflow with no gate and no registration. The #610 defect.
///   2. A workflow whose gate publishes no context branch protection requires.
///      Such a gate can be perfectly wired and still decide nothing, which is
///      the same "green means nothing" shape one level up.
///   3. A registration naming a file the enumeration did not produce. Deleting
///      the workflow and forgetting the entry looks identical to `workflowFiles`
///      quietly stopping at a narrower population, so both are red and the
///      message names the file that lost its coverage.
///   4. A registration for a file that now has a gate, or with no substantive
///      reason. An excuse that outlives its situation is worse than none,
///      because it reads as considered.
export function ungatedWorkflowFailures(
  relativeFiles,
  gateContexts,
  registry,
  protectedContexts,
) {
  const failures = [];
  const enumerated = new Set(relativeFiles);

  for (const file of relativeFiles) {
    const contexts = gateContexts.get(file) ?? [];
    if (contexts.length === 0) {
      if (registry.has(file)) continue;
      failures.push(
        `${file}: workflow publishes no gate job and is not registered in UNGATED_WORKFLOWS; ` +
          "every rule in this check reasons about a gate, so a workflow without one is judged by nothing at all " +
          "— give it a gate whose name is a required status check, or register it with the reason it does not need one",
      );
      continue;
    }
    const required = contexts.filter((context) =>
      protectedContexts.has(context),
    );
    if (required.length === 0) {
      failures.push(
        `${file}: gate job publishes ${contexts.map((context) => `"${context}"`).join(", ")}, ` +
          `none of which branch protection requires (${[...protectedContexts].sort().join(", ")}); ` +
          "a gate no required context resolves to cannot fail a merge, whatever it concludes",
      );
    }
  }

  for (const file of [...registry.keys()].sort()) {
    if (!enumerated.has(file)) {
      failures.push(
        `UNGATED_WORKFLOWS registers ${file}, which is not among the ${relativeFiles.length} workflow file(s) ` +
          "this check enumerated; either the workflow was deleted and the entry is stale, or the enumeration " +
          "stopped covering it and that file is now judged by nothing",
      );
      continue;
    }
    if ((gateContexts.get(file) ?? []).length > 0) {
      failures.push(
        `UNGATED_WORKFLOWS registers ${file} as deliberately ungated, but it now publishes a gate; ` +
          "remove the stale entry so the gate is held to the rules the registration excused it from",
      );
      continue;
    }
    const reason = (registry.get(file) ?? "").trim();
    if (reason.length < MINIMUM_REGISTRY_REASON) {
      failures.push(
        `UNGATED_WORKFLOWS registers ${file} with no substantive reason ` +
          `(${reason.length} character(s), at least ${MINIMUM_REGISTRY_REASON} required); ` +
          "an unexplained exemption is indistinguishable from an oversight",
      );
    }
  }

  return failures;
}

export function scanRepository(root, options = {}) {
  const tolerated = options.tolerated ?? TOLERATED_CONTEXT_COLLISIONS;
  const protectedContexts = options.protectedContexts ?? PROTECTED_CONTEXTS;
  const exemptions = options.exempt ?? GATE_EXEMPT_JOBS;
  const registry = options.ungated ?? UNGATED_WORKFLOWS;
  const failures = [];
  const published = [];
  const relativeFiles = [];
  const gateContexts = new Map();
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
    relativeFiles.push(relativeFile);
    gateContexts.set(relativeFile, []);
    for (const job of jobs) {
      const context = publishedContext(lines, job);
      published.push({ file: relativeFile, job: job.name, context });
      if (job.name !== "gate") continue;
      gates += 1;
      gateContexts.get(relativeFile).push(context);
      failures.push(...gateFailures(relativeFile, lines, job, siblings, exempt));
    }
  }
  failures.push(...protectedToleranceFailures(tolerated, protectedContexts));
  failures.push(...contextCollisionFailures(published, tolerated));
  failures.push(...protectedProducerFailures(published, protectedContexts));
  failures.push(
    ...ungatedWorkflowFailures(
      relativeFiles,
      gateContexts,
      registry,
      protectedContexts,
    ),
  );
  return {
    failures,
    gates,
    files: files.length,
    contexts: published.length,
    registered: [...registry.keys()].filter((file) =>
      relativeFiles.includes(file),
    ).length,
  };
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

/// A workflow with no gate at all — the shape rule 6 exists to reach. It is
/// deliberately well-formed in every other respect, so nothing but the absence
/// of a gate distinguishes it from a file this check would judge.
const UNGATED_WORKFLOW = `name: aside fixture

on:
  workflow_dispatch:

jobs:
  aside:
    runs-on: ubuntu-latest
    steps:
      - run: echo aside
`;

/// A reason long enough to satisfy MINIMUM_REGISTRY_REASON, so cases about
/// *which* file is registered are not accidentally testing the reason rule.
const FIXTURE_REASON =
  "Dispatch-only fixture that no pull-request event can ever trigger.";

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
/// live constants: the fixtures publish `gate` and not `rs / gate`, and an
/// allowlist entry added for a real workflow must not change what a self-test
/// case means. `gate` is protected unless a case says otherwise, so the
/// exactly-one-producer rule is exercised by every case and not only by its own.
function fixtureOptions(options) {
  return {
    protectedContexts: new Set(["gate"]),
    tolerated: new Map(),
    ungated: new Map(),
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
  // Both contexts are declared protected here because rule 6 now also asks
  // whether a gate resolves to a name branch protection requires; without that
  // this case would fail on the second gate being decorative rather than on the
  // property it exists to prove, which is that distinct `name:` values do not
  // collide.
  expectClean(
    "two gates in one tree with distinct display names",
    { "fixture.yml": EXPLICIT_GATE, "other.yml": NAMED_GATE },
    { gates: 2, protectedContexts: new Set(["gate", "other / gate"]) },
  );
  // The tolerated map is keyed by the exact producing files, not by the name,
  // so a third producer of a knowingly-duplicated name is still a failure.
  expectDetected(
    "a third producer of a tolerated duplicate context",
    {
      "fixture.yml": EXPLICIT_GATE,
      "other.yml": EXPLICIT_GATE,
      "third.yml": EXPLICIT_GATE,
    },
    /3 job\(s\) publish the status-check context "gate"/,
    {
      tolerated: new Map([
        [
          "gate",
          [".github/workflows/fixture.yml", ".github/workflows/other.yml"],
        ],
      ]),
    },
  );

  // Protected contexts. The allowlist may not name one, and the failure must
  // land on a tree where *nothing* collides yet: the whole point is that the
  // allowlist edit alone is red, before the `name:` removal it would enable.
  expectDetected(
    "a protected context added to the tolerated-collision allowlist",
    EXPLICIT_GATE,
    /TOLERATED_CONTEXT_COLLISIONS names "gate", which branch protection requires/,
    {
      tolerated: new Map([
        [
          "gate",
          [".github/workflows/fixture.yml", ".github/workflows/other.yml"],
        ],
      ]),
    },
  );
  // And the rule is about *which* name is on the allowlist, not about the
  // allowlist existing: an entry for an unprotected context still passes.
  expectClean(
    "a tolerated collision on a context that is not protected",
    EXPLICIT_GATE,
    {
      tolerated: new Map([
        ["build", [".github/workflows/one.yml", ".github/workflows/two.yml"]],
      ]),
    },
  );

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

  // Rule 6: every workflow accounted for. These are the only cases in this file
  // whose subject is a workflow the other rules cannot see at all, so each one
  // is checked against a tree that is otherwise entirely well-formed — the
  // gated `fixture.yml` is present throughout, and only the unjudged file
  // changes.
  expectDetected(
    "a workflow with no gate that nothing registers",
    { "fixture.yml": EXPLICIT_GATE, "aside.yml": UNGATED_WORKFLOW },
    /aside\.yml: workflow publishes no gate job and is not registered/,
  );
  expectClean(
    "a workflow registered as deliberately ungated",
    { "fixture.yml": EXPLICIT_GATE, "aside.yml": UNGATED_WORKFLOW },
    { ungated: new Map([[".github/workflows/aside.yml", FIXTURE_REASON]]) },
  );
  // The registration is only worth having if it decays: an entry naming a file
  // the enumeration did not produce is either a deleted workflow whose excuse
  // outlived it, or — the case this is really for — an enumeration that quietly
  // stopped covering that file.
  expectDetected(
    "a registration for a workflow the enumeration did not produce",
    { "fixture.yml": EXPLICIT_GATE },
    /UNGATED_WORKFLOWS registers \.github\/workflows\/aside\.yml, which is not among the 1 workflow file\(s\)/,
    { ungated: new Map([[".github/workflows/aside.yml", FIXTURE_REASON]]) },
  );
  expectDetected(
    "a registration for a workflow that has since gained a gate",
    { "fixture.yml": EXPLICIT_GATE, "other.yml": NAMED_GATE },
    /UNGATED_WORKFLOWS registers \.github\/workflows\/other\.yml as deliberately ungated, but it now publishes a gate/,
    {
      protectedContexts: new Set(["gate", "other / gate"]),
      ungated: new Map([[".github/workflows/other.yml", FIXTURE_REASON]]),
    },
  );
  expectDetected(
    "a registration with no substantive reason",
    { "fixture.yml": EXPLICIT_GATE, "aside.yml": UNGATED_WORKFLOW },
    /UNGATED_WORKFLOWS registers \.github\/workflows\/aside\.yml with no substantive reason/,
    { ungated: new Map([[".github/workflows/aside.yml", "  because  "]]) },
  );
  // A gate can satisfy every wiring rule above and still resolve to no name
  // branch protection requires, which is the whole defect one level up: it
  // concludes correctly and cannot fail a merge.
  expectDetected(
    "a gate that no required context resolves to",
    { "fixture.yml": EXPLICIT_GATE, "other.yml": NAMED_GATE },
    /other\.yml: gate job publishes "other \/ gate", none of which branch protection requires/,
  );

  console.log("check-workflow-gates self-test: 26 case(s) passed.");
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
    `no two workflows publish one status-check context, each protected context ` +
    `(${[...PROTECTED_CONTEXTS].sort().join(", ")}) has exactly one producer and no allowlist entry, ` +
    `and every workflow either feeds a required context or is registered as deliberately ungated: ` +
    `${result.gates} gate(s), ${result.registered} registered ungated, ` +
    `${result.contexts} job(s), ${result.files} workflow file(s).`,
);
