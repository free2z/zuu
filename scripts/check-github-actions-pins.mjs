#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
const EXTERNAL_USES = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@([^@\s]+)$/;
const GATE_CHECKOUT_REFERENCE =
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const GATE_POLICY_COMMAND = "node scripts/check-github-actions-pins.mjs";
const GATE_VERDICT_COMMAND =
  "node scripts/check-github-actions-pins.mjs --verify-gate-results";

// Required-gate policy deliberately accepts a small, canonical YAML subset.
// Alternate keys, inline job maps, aliases, and decorators fail closed instead
// of giving a second spelling to controls this checker must recognize.

function yamlFilesBelow(directory) {
  if (!fs.existsSync(directory)) return [];

  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...yamlFilesBelow(candidate));
    } else if (/\.ya?ml$/i.test(entry.name)) {
      files.push(candidate);
    }
  }
  return files;
}

function usesFromLine(line) {
  // Keep the policy deliberately smaller than a YAML parser: GitHub's usual
  // block-mapping form is supported below, while alternate key spellings and
  // inline collections that could hide `uses` fail closed. This also covers
  // valid constructs such as `steps: [{ uses: ... }]` and nested flow jobs.
  let keySearchLine = line;
  keySearchLine = keySearchLine.replace(
    /"(?:\\.|[^"])*"|'(?:''|[^'])*'/g,
    (quoted) => {
      let decoded;
      if (quoted[0] === '"') {
        try {
          decoded = JSON.parse(quoted);
        } catch {
          return quoted;
        }
      } else {
        decoded = quoted.slice(1, -1).replaceAll("''", "'");
      }
      // Preserve a decoded `uses` key for policy detection, but mask every
      // other quoted scalar so text such as "documentation uses: ..." cannot
      // be mistaken for a workflow key.
      return decoded === "uses" ? "uses" : '""';
    },
  );
  keySearchLine = keySearchLine.replace(/^\s*#.*$|\s+#.*$/, "");

  // Explicit keys and continued quoted keys can construct the literal key
  // `uses` across multiple source lines. The checker intentionally supports a
  // constrained, reviewable YAML spelling instead of trying to reimplement a
  // complete YAML resolver.
  if (/^\s*(?:-\s*)?\?\s*/.test(keySearchLine)) {
    return {
      error: "explicit YAML mapping keys are unsupported; put `uses:` on its own line",
    };
  }
  if (/^\s*(?:-\s*)?"(?:\\.|[^"])*\\\s*$/.test(line)) {
    return {
      error: "continued quoted YAML scalars are unsupported because they can construct `uses`",
    };
  }
  if (/[\[,{]\s*(?:"(?:\\.|[^"])*"|'(?:''|[^'])*')\s*:/.test(keySearchLine)) {
    return {
      error: "quoted keys in inline YAML mappings are unsupported because they can encode `uses`",
    };
  }

  const match = line.match(/^\s*(?:-\s*)?uses\s*:\s*(.*?)\s*$/);
  let scalar;
  if (match) {
    scalar = match[1];
  } else {
    const quotedKey = line.match(
      /^\s*(?:-\s*)?((?:"(?:\\.|[^"])*")|(?:'(?:''|[^'])*'))\s*:\s*(.*?)\s*$/,
    );
    if (quotedKey) {
      let key;
      if (quotedKey[1][0] === '"') {
        try {
          key = JSON.parse(quotedKey[1]);
        } catch {
          return { error: "quoted YAML mapping key cannot be decoded safely" };
        }
      } else {
        key = quotedKey[1].slice(1, -1).replaceAll("''", "'");
      }
      if (key !== "uses") return null;
      scalar = quotedKey[2];
    }
  }

  if (!match && scalar === undefined) {
    if (
      /(?:^|[\s[,{?])\*[^\s:[\]{},]+\s*:/.test(keySearchLine) ||
      /^\s*(?:-\s*)?\?\s*\*[^\s:[\]{},]+\s*$/.test(keySearchLine)
    ) {
      return {
        error:
          "YAML aliases are unsupported as mapping keys because they can resolve to `uses`",
      };
    }
    if (
      /\buses\s*:/.test(keySearchLine) ||
      /^\s*(?:-\s*)?\??\s*(?:(?:&|!)[^\s]+\s+)*uses\s*$/.test(keySearchLine)
    ) {
      return {
        error:
          "decorated, inline, or explicit `uses` mappings are unsupported; put `uses:` on its own line",
      };
    }
    return null;
  }

  if (!scalar) return { error: "empty `uses:` value" };

  if (scalar[0] === '"' || scalar[0] === "'") {
    const quote = scalar[0];
    const closing = scalar.indexOf(quote, 1);
    if (closing < 0) return { error: "unterminated quoted `uses:` value" };

    const trailing = scalar.slice(closing + 1).trim();
    if (trailing && !trailing.startsWith("#")) {
      return { error: "unexpected content after quoted `uses:` value" };
    }
    return {
      provenance: trailing.startsWith("#") ? trailing.slice(1).trim() : "",
      ref: scalar.slice(1, closing),
    };
  }

  const comment = scalar.search(/\s+#/);
  const ref = (comment < 0 ? scalar : scalar.slice(0, comment)).trim();
  const provenance = comment < 0 ? "" : scalar.slice(comment).replace(/^\s+#/, "").trim();
  return ref ? { provenance, ref } : { error: "empty `uses:` value" };
}

function stripYamlComment(line) {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (doubleQuoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        doubleQuoted = false;
      }
      continue;
    }
    if (singleQuoted) {
      if (character === "'" && line[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (character === '"') {
      doubleQuoted = true;
    } else if (character === "'") {
      singleQuoted = true;
    } else if (
      character === "#" &&
      (index === 0 || /\s/.test(line[index - 1]))
    ) {
      return line.slice(0, index).trimEnd();
    }
  }
  return line.trimEnd();
}

function workflowLine(line) {
  const withoutComment = stripYamlComment(line);
  if (!withoutComment.trim()) return null;

  const prefix = withoutComment.match(/^[ \t]*/)?.[0] ?? "";
  if (prefix.includes("\t")) {
    return { error: "tabs are unsupported in YAML indentation" };
  }
  return {
    indent: prefix.length,
    text: withoutComment.slice(prefix.length),
  };
}

function decodeRestrictedYamlScalar(raw, kind) {
  const scalar = raw.trim();
  if (!scalar) return { error: `empty ${kind}` };

  if (scalar[0] === '"') {
    try {
      const decoded = JSON.parse(scalar);
      if (typeof decoded !== "string") throw new Error("not a string");
      return { value: decoded };
    } catch {
      return {
        error: `${kind} uses unsupported double-quoted YAML escaping`,
      };
    }
  }
  if (scalar[0] === "'") {
    if (scalar.at(-1) !== "'" || scalar.length < 2) {
      return { error: `unterminated single-quoted ${kind}` };
    }
    return { value: scalar.slice(1, -1).replaceAll("''", "'") };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(scalar)) {
    return {
      error: `${kind} must use a plain or quoted scalar without YAML decorators`,
    };
  }
  return { value: scalar };
}

function mappingEntry(source, kind) {
  const match = source.match(
    /^((?:"(?:\\.|[^"\\])*")|(?:'(?:''|[^'])*')|(?:[A-Za-z_][A-Za-z0-9_-]*)|<<)\s*:\s*(.*)$/,
  );
  if (!match) {
    return {
      error: `${kind} must use an undecorated block mapping key`,
    };
  }
  if (match[1] === "<<") {
    return {
      error: `${kind} cannot use YAML merge keys or aliases`,
    };
  }
  const decoded = decodeRestrictedYamlScalar(match[1], `${kind} key`);
  if (decoded.error) return decoded;
  return { key: decoded.value, value: match[2].trim() };
}

function parseGateNeeds(lines, needsIndex, needsIndent) {
  const source = workflowLine(lines[needsIndex]);
  const entry = mappingEntry(source.text, "gate needs");
  const raw = entry.value;
  const values = [];

  if (raw) {
    let scalars;
    if (raw.startsWith("[") && raw.endsWith("]")) {
      const inside = raw.slice(1, -1).trim();
      scalars = inside ? inside.split(",") : [];
    } else {
      scalars = [raw];
    }
    for (const scalar of scalars) {
      const decoded = decodeRestrictedYamlScalar(scalar, "gate dependency");
      if (decoded.error) return { error: decoded.error };
      values.push(decoded.value);
    }
  } else {
    let itemIndent = null;
    for (let index = needsIndex + 1; index < lines.length; index += 1) {
      const line = workflowLine(lines[index]);
      if (!line) continue;
      if (line.error) return { error: line.error };
      if (line.indent <= needsIndent) break;
      if (itemIndent === null) itemIndent = line.indent;
      if (line.indent !== itemIndent || !line.text.startsWith("- ")) {
        return {
          error: "gate needs must be a scalar list without YAML decorators",
        };
      }
      const decoded = decodeRestrictedYamlScalar(
        line.text.slice(2),
        "gate dependency",
      );
      if (decoded.error) return { error: decoded.error };
      values.push(decoded.value);
    }
  }

  if (!values.length) return { error: "gate needs must not be empty" };
  if (new Set(values).size !== values.length) {
    return { error: "gate needs contains duplicate dependencies" };
  }
  return { values };
}

function blockScalarCommands(lines, property, end) {
  if (property.value && !/^[|>][+-]?[1-9]?$/.test(property.value)) {
    return [property.value];
  }
  const commands = [];
  for (let index = property.index + 1; index < end; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line) continue;
    if (line.error || line.indent <= property.indent) break;
    if (!line.text.trimStart().startsWith("#")) commands.push(line.text.trim());
  }
  return commands;
}

function gateSteps(relativeFile, lines, gate, failures) {
  const stepsProperty = gate.properties.get("steps");
  if (!stepsProperty || stepsProperty.value) {
    failures.push(
      `${relativeFile}:${gate.start + 1}: gate steps must use a block sequence`,
    );
    return [];
  }

  const steps = [];
  for (let index = stepsProperty.index + 1; index < gate.end; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line || line.error || line.indent !== 6) continue;
    if (!line.text.startsWith("- ")) {
      failures.push(
        `${relativeFile}:${index + 1}: gate steps must use canonical block-sequence entries`,
      );
      continue;
    }
    const entry = mappingEntry(line.text.slice(2), "gate step");
    if (entry.error) {
      failures.push(`${relativeFile}:${index + 1}: ${entry.error}`);
      continue;
    }
    const step = { start: index, properties: new Map() };
    step.properties.set(entry.key, {
      index,
      indent: 6,
      value: entry.value,
    });
    steps.push(step);
  }

  for (const [position, step] of steps.entries()) {
    step.end = steps[position + 1]?.start ?? gate.end;
    for (let index = step.start + 1; index < step.end; index += 1) {
      const line = workflowLine(lines[index]);
      if (!line || line.error || line.indent !== 8) continue;
      const entry = mappingEntry(line.text, "gate step property");
      if (entry.error) {
        failures.push(`${relativeFile}:${index + 1}: ${entry.error}`);
        continue;
      }
      if (step.properties.has(entry.key)) {
        failures.push(
          `${relativeFile}:${index + 1}: duplicate ${entry.key} property on gate step`,
        );
        continue;
      }
      step.properties.set(entry.key, {
        index,
        indent: 8,
        value: entry.value,
      });
    }
  }
  return steps;
}

function stepEnvironment(relativeFile, lines, step, failures) {
  const environment = new Map();
  const property = step.properties.get("env");
  if (!property || property.value) return environment;

  for (let index = property.index + 1; index < step.end; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line) continue;
    if (line.error || line.indent <= property.indent) break;
    if (line.indent !== 10) {
      failures.push(
        `${relativeFile}:${index + 1}: gate verdict environment must use canonical indentation`,
      );
      continue;
    }
    const entry = mappingEntry(line.text, "gate verdict environment");
    if (entry.error) {
      failures.push(`${relativeFile}:${index + 1}: ${entry.error}`);
      continue;
    }
    if (environment.has(entry.key)) {
      failures.push(
        `${relativeFile}:${index + 1}: duplicate gate verdict environment key ${entry.key}`,
      );
    } else {
      environment.set(entry.key, entry.value);
    }
  }
  return environment;
}

function hasExactKeys(map, keys) {
  return (
    map.size === keys.length &&
    keys.every((key) => map.has(key))
  );
}

function requiredGateControlFailures(relativeFile, lines, gate) {
  const failures = [];
  const steps = gateSteps(relativeFile, lines, gate, failures);
  if (steps.length !== 3) {
    failures.push(
      `${relativeFile}:${gate.start + 1}: gate must contain exactly checkout, policy recheck, and enforcing verdict steps`,
    );
    return failures;
  }

  const [checkout, policy, verdict] = steps;
  if (
    !hasExactKeys(checkout.properties, ["uses"]) ||
    checkout.properties.get("uses")?.value !== GATE_CHECKOUT_REFERENCE
  ) {
    failures.push(
      `${relativeFile}:${checkout.start + 1}: gate checkout must be exact, current-source, and unconditional`,
    );
  }

  if (
    !hasExactKeys(policy.properties, ["name", "id", "run"]) ||
    policy.properties.get("name")?.value !==
      "Recheck immutable actions and fail-closed required jobs" ||
    policy.properties.get("id")?.value !== "policy" ||
    policy.properties.get("run")?.value !== GATE_POLICY_COMMAND
  ) {
    failures.push(
      `${relativeFile}:${policy.start + 1}: gate policy recheck must be exact, unconditional, and non-soft-failing`,
    );
  }

  const verdictEnvironment = stepEnvironment(
    relativeFile,
    lines,
    verdict,
    failures,
  );
  const verdictCommands = blockScalarCommands(
    lines,
    verdict.properties.get("run") ?? { index: verdict.start, indent: 8, value: "" },
    verdict.end,
  );
  if (
    !hasExactKeys(verdict.properties, ["name", "env", "run"]) ||
    verdict.properties.get("name")?.value !==
      "Verify required jobs succeeded or legitimately skipped" ||
    !hasExactKeys(verdictEnvironment, ["POLICY_OUTCOME", "REQUIRED_JOBS_JSON"]) ||
    verdictEnvironment.get("POLICY_OUTCOME") !== "${{ steps.policy.outcome }}" ||
    verdictEnvironment.get("REQUIRED_JOBS_JSON") !== "${{ toJSON(needs) }}" ||
    verdictCommands.length !== 2 ||
    verdictCommands[0] !== GATE_POLICY_COMMAND ||
    verdictCommands[1] !== GATE_VERDICT_COMMAND
  ) {
    failures.push(
      `${relativeFile}:${verdict.start + 1}: gate verdict must unconditionally recheck policy and enforce the complete needs context`,
    );
  }
  return failures;
}

function gatePolicyFailures(relativeFile, lines) {
  const failures = [];
  const topLevel = [];
  const requiredGateWorkflow =
    relativeFile.split(path.sep).join("/") === ".github/workflows/zuuli.yml";

  for (const [index, rawLine] of lines.entries()) {
    const line = workflowLine(rawLine);
    if (!line) continue;
    if (line.error) {
      failures.push(`${relativeFile}:${index + 1}: ${line.error}`);
      continue;
    }
    if (line.indent !== 0 || line.text === "---") continue;
    const entry = mappingEntry(line.text, "top-level workflow property");
    if (entry.error) {
      failures.push(`${relativeFile}:${index + 1}: ${entry.error}`);
    } else if (entry.key === "jobs") {
      topLevel.push({ index, value: entry.value });
    }
  }

  if (!topLevel.length) {
    if (requiredGateWorkflow) {
      failures.push(`${relativeFile}: required workflow must contain a jobs block mapping`);
    }
    return failures;
  }
  if (topLevel.length !== 1) {
    failures.push(`${relativeFile}: workflow must contain exactly one jobs mapping`);
    return failures;
  }
  const jobsEntry = topLevel[0];
  if (jobsEntry.value) {
    failures.push(
      `${relativeFile}:${jobsEntry.index + 1}: jobs must use a block mapping so required-gate policy can inspect it`,
    );
    return failures;
  }

  let jobsEnd = lines.length;
  for (let index = jobsEntry.index + 1; index < lines.length; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line) continue;
    if (line.error) continue;
    if (line.indent === 0) {
      jobsEnd = index;
      break;
    }
  }

  const firstJobLine = lines
    .slice(jobsEntry.index + 1, jobsEnd)
    .map((line) => workflowLine(line))
    .find((line) => line && !line.error);
  if (!firstJobLine || firstJobLine.indent !== 2) {
    failures.push(
      `${relativeFile}:${jobsEntry.index + 1}: jobs must use canonical two-space block indentation`,
    );
  }

  const jobs = new Map();
  for (let index = jobsEntry.index + 1; index < jobsEnd; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line || line.error || line.indent !== 2) continue;
    const entry = mappingEntry(line.text, "job definition");
    if (entry.error) {
      failures.push(`${relativeFile}:${index + 1}: ${entry.error}`);
      continue;
    }
    if (entry.value) {
      failures.push(
        `${relativeFile}:${index + 1}: job ${entry.key} must use a block mapping; ` +
          "inline maps, aliases, and decorated job values are unsupported",
      );
      continue;
    }
    if (jobs.has(entry.key)) {
      failures.push(`${relativeFile}:${index + 1}: duplicate job definition: ${entry.key}`);
      continue;
    }
    jobs.set(entry.key, { id: entry.key, start: index, properties: new Map() });
  }

  const orderedJobs = [...jobs.values()].sort((left, right) => left.start - right.start);
  for (const [position, job] of orderedJobs.entries()) {
    job.end = orderedJobs[position + 1]?.start ?? jobsEnd;
    const firstProperty = lines
      .slice(job.start + 1, job.end)
      .map((line) => workflowLine(line))
      .find((line) => line && !line.error);
    if (!firstProperty || firstProperty.indent !== 4) {
      failures.push(
        `${relativeFile}:${job.start + 1}: job ${job.id} must use canonical four-space property indentation`,
      );
    }
    for (let index = job.start + 1; index < job.end; index += 1) {
      const line = workflowLine(lines[index]);
      if (!line || line.error || line.indent !== 4) continue;
      const entry = mappingEntry(line.text, `job ${job.id} property`);
      if (entry.error) {
        failures.push(`${relativeFile}:${index + 1}: ${entry.error}`);
        continue;
      }
      if (job.properties.has(entry.key)) {
        failures.push(
          `${relativeFile}:${index + 1}: duplicate ${entry.key} property on job ${job.id}`,
        );
        continue;
      }
      job.properties.set(entry.key, { index, value: entry.value });
    }
  }

  const gate = jobs.get("gate");
  if (!gate) {
    if (requiredGateWorkflow) {
      failures.push(`${relativeFile}: required workflow must contain the gate job`);
    }
    return failures;
  }
  const needsProperty = gate.properties.get("needs");
  if (!needsProperty) {
    failures.push(`${relativeFile}:${gate.start + 1}: required gate must declare needs`);
    return failures;
  }
  const parsedNeeds = parseGateNeeds(lines, needsProperty.index, 4);
  if (parsedNeeds.error) {
    failures.push(`${relativeFile}:${needsProperty.index + 1}: ${parsedNeeds.error}`);
    return failures;
  }

  for (const dependency of parsedNeeds.values) {
    if (!jobs.has(dependency)) {
      failures.push(
        `${relativeFile}:${needsProperty.index + 1}: gate depends on undefined job ${dependency}`,
      );
    }
  }

  for (const jobId of [...parsedNeeds.values, "gate"]) {
    const property = jobs.get(jobId)?.properties.get("continue-on-error");
    if (property) {
      failures.push(
        `${relativeFile}:${property.index + 1}: job-level continue-on-error is forbidden on required-gate job ${jobId}`,
      );
    }
  }

  if (gate.properties.get("if")?.value !== "always()") {
    failures.push(
      `${relativeFile}:${gate.start + 1}: required gate must run with if: always()`,
    );
  }
  failures.push(...requiredGateControlFailures(relativeFile, lines, gate));

  return failures;
}

function selectorResult(value, name) {
  if (value === "true") return "success";
  if (value === "false") return "skipped";
  throw new Error(`invalid or missing ${name} change-detector output: ${value}`);
}

function verifyGateResults(policyOutcome, serializedNeeds) {
  if (policyOutcome !== "success") {
    throw new Error(`gate-local policy recheck did not pass: ${policyOutcome || "missing"}`);
  }

  let needs;
  try {
    needs = JSON.parse(serializedNeeds);
  } catch {
    throw new Error("required jobs context is not valid JSON");
  }
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) {
    throw new Error("required jobs context must be a JSON object");
  }
  const entries = Object.entries(needs);
  if (!entries.length || !needs.changes) {
    throw new Error("required jobs context must include changes");
  }

  const changes = needs.changes;
  if (changes.result !== "success") {
    throw new Error(`change detection did not pass: ${changes.result || "missing"}`);
  }
  if (!changes.outputs || typeof changes.outputs !== "object") {
    throw new Error("change detection outputs are missing");
  }
  const zuuliExpected = selectorResult(changes.outputs.zuuli, "ZUULI");
  const schemaExpected = selectorResult(
    changes.outputs.zuuallet_schema,
    "Zuuallet schema",
  );

  const verdicts = [];
  for (const [job, state] of entries) {
    if (!state || typeof state !== "object" || typeof state.result !== "string") {
      throw new Error(`required job ${job} has no result`);
    }
    const expected =
      job === "changes"
        ? "success"
        : job === "zuuallet_schema"
          ? schemaExpected
          : zuuliExpected;
    if (state.result !== expected) {
      throw new Error(
        `required job ${job} must be ${expected}, got ${state.result}`,
      );
    }
    verdicts.push(`${job}=${state.result}`);
  }
  return verdicts;
}

function localTarget(repoRoot, reference) {
  const relative = reference.slice(2);
  const candidate = path.resolve(repoRoot, relative);
  const relativeCandidate = path.relative(repoRoot, candidate);
  if (relativeCandidate.startsWith("..") || path.isAbsolute(relativeCandidate)) {
    return { error: `local action escapes the repository: ${reference}` };
  }
  if (!fs.existsSync(candidate)) {
    return { error: `local action or workflow does not exist: ${reference}` };
  }
  const canonical = fs.realpathSync(candidate);
  const relativeCanonical = path.relative(repoRoot, canonical);
  if (relativeCanonical.startsWith("..") || path.isAbsolute(relativeCanonical)) {
    return { error: `local action resolves outside the repository: ${reference}` };
  }
  if (fs.statSync(candidate).isFile()) return { file: candidate };

  const actionFiles = ["action.yml", "action.yaml"]
    .map((name) => path.join(candidate, name))
    .filter((file) => fs.existsSync(file));
  if (actionFiles.length !== 1) {
    return {
      error: `local action directory must contain exactly one action.yml or action.yaml: ${reference}`,
    };
  }
  return { file: actionFiles[0] };
}

function scanRepository(repoRoot) {
  repoRoot = fs.realpathSync(repoRoot);
  const queued = [
    ...yamlFilesBelow(path.join(repoRoot, ".github", "workflows")),
    ...yamlFilesBelow(path.join(repoRoot, ".github", "actions")),
  ];
  const seen = new Set();
  const failures = [];
  let externalReferences = 0;

  while (queued.length) {
    const file = queued.shift();
    const canonical = fs.realpathSync(file);
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    const relativeFile = path.relative(repoRoot, file);
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    if (relativeFile.startsWith(path.join(".github", "workflows") + path.sep)) {
      failures.push(...gatePolicyFailures(relativeFile, lines));
    }
    for (const [index, line] of lines.entries()) {
      const parsed = usesFromLine(line);
      if (!parsed) continue;
      const location = `${relativeFile}:${index + 1}`;
      if (parsed.error) {
        failures.push(`${location}: ${parsed.error}`);
        continue;
      }

      const reference = parsed.ref;
      if (reference.startsWith("./")) {
        const target = localTarget(repoRoot, reference);
        if (target.error) failures.push(`${location}: ${target.error}`);
        else queued.push(target.file);
        continue;
      }

      externalReferences += 1;
      const external = reference.match(EXTERNAL_USES);
      if (!external) {
        failures.push(`${location}: invalid external \`uses:\` reference: ${reference}`);
      } else if (!FULL_COMMIT_SHA.test(external[1])) {
        failures.push(
          `${location}: external \`uses:\` reference must end in a full lowercase 40-character commit SHA: ${reference}`,
        );
      } else if (!parsed.provenance) {
        failures.push(
          `${location}: commit-pinned external \`uses:\` reference needs a nonempty trailing version/provenance comment: ${reference}`,
        );
      }
    }
  }

  return {
    externalReferences,
    failures,
    scannedFiles: seen.size,
  };
}

function writeFixture(root, relative, contents) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

function runCurrentWorkflowMutationTests(repoRoot) {
  const relative = path.join(".github", "workflows", "zuuli.yml");
  const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
  const baseline = gatePolicyFailures(relative, source.split(/\r?\n/));
  if (baseline.length) {
    throw new Error(`current required workflow is not a valid mutation base: ${baseline.join("; ")}`);
  }
  const replaceLast = (value, target, replacement) => {
    const index = value.lastIndexOf(target);
    if (index < 0) return value;
    return value.slice(0, index) + replacement + value.slice(index + target.length);
  };

  const checkoutLine =
    `      - uses: ${GATE_CHECKOUT_REFERENCE} # v7.0.1\n`;
  const policyName =
    "      - name: Recheck immutable actions and fail-closed required jobs";
  const policyBlock = [
    policyName,
    "        id: policy",
    `        run: ${GATE_POLICY_COMMAND}`,
    "",
  ].join("\n");
  const verdictName =
    "      - name: Verify required jobs succeeded or legitimately skipped";
  const mutations = [
    {
      name: "real workflow rejects log-only needs consumption",
      needle: "must unconditionally recheck policy and enforce the complete needs context",
      source: source.replace(
        `          ${GATE_VERDICT_COMMAND}\n`,
        '          echo "$REQUIRED_JOBS_JSON"\n',
      ),
    },
    {
      name: "real workflow rejects a dynamically dead verdict",
      needle: "must unconditionally recheck policy and enforce the complete needs context",
      source: source.replace(
        verdictName,
        `${verdictName}\n        if: github.event_name == '__never__'`,
      ),
    },
    {
      name: "real workflow rejects deleted gate checkout",
      needle: "must contain exactly checkout, policy recheck, and enforcing verdict steps",
      source: replaceLast(source, checkoutLine, ""),
    },
    {
      name: "real workflow rejects skipped gate checkout",
      needle: "gate checkout must be exact, current-source, and unconditional",
      source: replaceLast(
        source,
        checkoutLine,
        `${checkoutLine.trimEnd()}\n        if: false\n`,
      ),
    },
    {
      name: "real workflow rejects deleted policy recheck",
      needle: "must contain exactly checkout, policy recheck, and enforcing verdict steps",
      source: source.replace(policyBlock, ""),
    },
    {
      name: "real workflow rejects dynamically dead policy recheck",
      needle: "gate policy recheck must be exact, unconditional, and non-soft-failing",
      source: source.replace(
        policyName,
        `${policyName}\n        if: github.event_name == '__never__'`,
      ),
    },
    {
      name: "real workflow rejects soft-failing policy recheck",
      needle: "gate policy recheck must be exact, unconditional, and non-soft-failing",
      source: source.replace(
        policyName,
        `${policyName}\n        continue-on-error: true`,
      ),
    },
    {
      name: "real workflow rejects soft-failing required dependency",
      needle: "job-level continue-on-error is forbidden on required-gate job rust_app",
      source: source.replace(
        "  rust_app:\n",
        "  rust_app:\n    continue-on-error: true\n",
      ),
    },
  ];

  for (const mutation of mutations) {
    if (mutation.source === source) {
      throw new Error(`${mutation.name}: mutation target was not found`);
    }
    const failures = gatePolicyFailures(relative, mutation.source.split(/\r?\n/));
    if (!failures.some((failure) => failure.includes(mutation.needle))) {
      throw new Error(
        `${mutation.name}: expected ${JSON.stringify(mutation.needle)}, got ${failures.join("; ")}`,
      );
    }
    console.log(`self-test: ${mutation.name}: passed`);
  }
  return mutations.length;
}

function runSelfTest(repoRoot) {
  const fullSha = "0123456789abcdef0123456789abcdef01234567";
  const gateFixture = (contents) => ({
    ".github/workflows/zuuli.yml": contents,
  });
  const gateCheckoutLines = [
    `      - uses: ${GATE_CHECKOUT_REFERENCE} # v7.0.1`,
  ];
  const gatePolicyLines = [
    "      - name: Recheck immutable actions and fail-closed required jobs",
    "        id: policy",
    `        run: ${GATE_POLICY_COMMAND}`,
  ];
  const gateVerdictLines = [
    "      - name: Verify required jobs succeeded or legitimately skipped",
    "        env:",
    "          POLICY_OUTCOME: ${{ steps.policy.outcome }}",
    "          REQUIRED_JOBS_JSON: ${{ toJSON(needs) }}",
    "        run: |",
    `          ${GATE_POLICY_COMMAND}`,
    `          ${GATE_VERDICT_COMMAND}`,
  ];
  const validGateWorkflow = [
    "name: required gate fixture",
    "on: pull_request",
    "jobs:",
    "  advisory:",
    "    continue-on-error: true",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: exit 1",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: a legitimate best-effort step",
    "        continue-on-error: true",
    "        run: echo 'step-level continue-on-error: true is allowed'",
    "  gate:",
    "    needs: [build]",
    "    if: always()",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...gateCheckoutLines,
    ...gatePolicyLines,
    ...gateVerdictLines,
    "",
  ].join("\n");
  const cases = [
    {
      name: "valid pinned, quoted, reusable, and nested-local references",
      valid: true,
      files: {
        ".github/workflows/gate.yml": `steps:\n  - uses: ./.github/actions/outer\n  - uses: owner/action@${fullSha} # v1.2.3\n  - uses: "owner/repo/.github/workflows/reuse.yml@${fullSha}" # v4\n`,
        ".github/actions/outer/action.yml":
          "runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/inner\n",
        ".github/actions/inner/action.yaml": `runs:\n  using: composite\n  steps:\n    - uses: 'owner/nested@${fullSha}' # v2\n`,
      },
    },
    {
      name: "valid required gate permits advisory jobs and best-effort steps",
      valid: true,
      files: gateFixture(validGateWorkflow),
    },
    {
      name: "gate dependency cannot use job-level continue-on-error",
      needle: "job-level continue-on-error is forbidden on required-gate job build",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n    continue-on-error: true\n",
        ),
      ),
    },
    {
      name: "false job-level continue-on-error is still forbidden",
      needle: "job-level continue-on-error is forbidden on required-gate job build",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n    continue-on-error: false\n",
        ),
      ),
    },
    {
      name: "escaped quoted key cannot hide job-level continue-on-error",
      needle: "job-level continue-on-error is forbidden on required-gate job build",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          '  build:\n    "continue-\\u006fn-error": true\n',
        ),
      ),
    },
    {
      name: "single-quoted key cannot hide job-level continue-on-error",
      needle: "job-level continue-on-error is forbidden on required-gate job build",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n    'continue-on-error': true\n",
        ),
      ),
    },
    {
      name: "decorated job property fails closed",
      needle: "must use an undecorated block mapping key",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n    &policy continue-on-error: true\n",
        ),
      ),
    },
    {
      name: "explicit job property fails closed",
      needle: "must use an undecorated block mapping key",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n    ? continue-on-error\n    : true\n",
        ),
      ),
    },
    {
      name: "job merge aliases fail closed",
      needle: "cannot use YAML merge keys or aliases",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n    <<: *soft-failure\n",
        ),
      ),
    },
    {
      name: "inline job maps fail closed",
      needle: "must use a block mapping",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n    runs-on: ubuntu-latest\n    steps:\n      - name: a legitimate best-effort step\n        continue-on-error: true\n        run: echo 'step-level continue-on-error: true is allowed'\n",
          "  build: { runs-on: ubuntu-latest, continue-on-error: true }\n",
        ),
      ),
    },
    {
      name: "reindented direct job properties fail closed",
      needle: "job build must use canonical four-space property indentation",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n    runs-on: ubuntu-latest\n    steps:\n      - name: a legitimate best-effort step\n        continue-on-error: true\n        run: echo 'step-level continue-on-error: true is allowed'\n",
          "  build:\n      continue-on-error: true\n      runs-on: ubuntu-latest\n      steps:\n        - run: exit 1\n",
        ),
      ),
    },
    {
      name: "required gate itself cannot ignore failures",
      needle: "job-level continue-on-error is forbidden on required-gate job gate",
      files: gateFixture(
        validGateWorkflow.replace(
          "  gate:\n",
          "  gate:\n    continue-on-error: true\n",
        ),
      ),
    },
    {
      name: "block-sequence gate needs remain supported",
      valid: true,
      files: gateFixture(
        validGateWorkflow.replace(
          "    needs: [build]\n",
          "    needs:\n      - build\n",
        ),
      ),
    },
    {
      name: "future gate dependency is covered by the complete needs context",
      valid: true,
      files: gateFixture(
        validGateWorkflow
          .replace(
            "  gate:\n",
            "  rust_android_32:\n    runs-on: ubuntu-latest\n    steps:\n      - run: cargo check\n  gate:\n",
          )
          .replace(
            "    needs: [build]\n",
            "    needs: [build, rust_android_32]\n",
          ),
      ),
    },
    {
      name: "logging the needs context cannot replace the enforcing verdict",
      needle: "must unconditionally recheck policy and enforce the complete needs context",
      files: gateFixture(
        validGateWorkflow.replace(
          `          ${GATE_VERDICT_COMMAND}\n`,
          '          echo "$REQUIRED_JOBS_JSON"\n',
        ),
      ),
    },
    {
      name: "dynamically dead verdict use fails closed",
      needle: "must unconditionally recheck policy and enforce the complete needs context",
      files: gateFixture(
        validGateWorkflow.replace(
          gateVerdictLines[0],
          `${gateVerdictLines[0]}\n        if: github.event_name == '__never__'`,
        ),
      ),
    },
    {
      name: "deleted gate checkout fails closed",
      needle: "must contain exactly checkout, policy recheck, and enforcing verdict steps",
      files: gateFixture(
        validGateWorkflow.replace(`${gateCheckoutLines.join("\n")}\n`, ""),
      ),
    },
    {
      name: "skipped gate checkout fails closed",
      needle: "gate checkout must be exact, current-source, and unconditional",
      files: gateFixture(
        validGateWorkflow.replace(
          gateCheckoutLines[0],
          `${gateCheckoutLines[0]}\n        if: false`,
        ),
      ),
    },
    {
      name: "deleted gate policy recheck fails closed",
      needle: "must contain exactly checkout, policy recheck, and enforcing verdict steps",
      files: gateFixture(
        validGateWorkflow.replace(`${gatePolicyLines.join("\n")}\n`, ""),
      ),
    },
    {
      name: "dynamically dead gate policy recheck fails closed",
      needle: "gate policy recheck must be exact, unconditional, and non-soft-failing",
      files: gateFixture(
        validGateWorkflow.replace(
          gatePolicyLines[0],
          `${gatePolicyLines[0]}\n        if: github.event_name == '__never__'`,
        ),
      ),
    },
    {
      name: "soft-failing gate policy recheck fails closed",
      needle: "gate policy recheck must be exact, unconditional, and non-soft-failing",
      files: gateFixture(
        validGateWorkflow.replace(
          gatePolicyLines[0],
          `${gatePolicyLines[0]}\n        continue-on-error: true`,
        ),
      ),
    },
    {
      name: "tag",
      needle: "owner/action@v1",
      files: { ".github/workflows/gate.yml": "steps:\n  - uses: owner/action@v1\n" },
    },
    {
      name: "branch",
      needle: "owner/action@main",
      files: { ".github/workflows/gate.yml": "steps:\n  - uses: owner/action@main\n" },
    },
    {
      name: "short SHA",
      needle: "owner/action@0123456",
      files: { ".github/workflows/gate.yml": "steps:\n  - uses: owner/action@0123456\n" },
    },
    {
      name: "commit pin without readable provenance",
      needle: "version/provenance comment",
      files: { ".github/workflows/gate.yml": `steps:\n  - uses: owner/action@${fullSha}\n` },
    },
    {
      name: "mutable reusable workflow",
      needle: "owner/repo/.github/workflows/reuse.yml@release",
      files: {
        ".github/workflows/gate.yml":
          "jobs:\n  call:\n    uses: owner/repo/.github/workflows/reuse.yml@release\n",
      },
    },
    {
      name: "quoted mutable reference",
      needle: "owner/action@v2",
      files: { ".github/workflows/gate.yml": 'steps:\n  - uses: "owner/action@v2" # mutable\n' },
    },
    {
      name: "quoted uses key cannot hide a mutable reference",
      needle: "owner/action@v4",
      files: {
        ".github/workflows/gate.yml": 'steps:\n  - "uses": owner/action@v4\n  - \'uses\': owner/other@main\n',
      },
    },
    {
      name: "escaped quoted uses key cannot hide a mutable reference",
      needle: "owner/action@main",
      files: {
        ".github/workflows/gate.yml": 'steps:\n  - "\\u0075ses": owner/action@main\n',
      },
    },
    {
      name: "nested local action is scanned",
      needle: "owner/nested@nightly",
      files: {
        ".github/workflows/gate.yml": "steps:\n  - uses: ./.github/actions/nested\n",
        ".github/actions/nested/action.yml":
          "runs:\n  using: composite\n  steps:\n    - uses: owner/nested@nightly\n",
      },
    },
    {
      name: "missing local action fails closed",
      needle: "does not exist",
      files: { ".github/workflows/gate.yml": "steps:\n  - uses: ./.github/actions/missing\n" },
    },
    {
      name: "expression reference fails closed",
      needle: "invalid external",
      files: { ".github/workflows/gate.yml": "steps:\n  - uses: owner/action@${{ inputs.ref }}\n" },
    },
    {
      name: "flow-style step reference fails closed",
      needle: "decorated, inline, or explicit",
      files: {
        ".github/workflows/gate.yml": `steps:\n  - { uses: owner/action@${fullSha}, name: hidden }\n`,
      },
    },
    {
      name: "inline steps sequence cannot hide a mutable reference",
      needle: "decorated, inline, or explicit",
      files: {
        ".github/workflows/gate.yml": "steps: [{ uses: owner/action@v1 }]\n",
      },
    },
    {
      name: "nested inline jobs cannot hide a mutable reusable workflow",
      needle: "decorated, inline, or explicit",
      files: {
        ".github/workflows/gate.yml":
          "jobs: { call: { uses: owner/repo/.github/workflows/reuse.yml@main } }\n",
      },
    },
    {
      name: "quoted inline key cannot hide a mutable reference",
      needle: "decorated, inline, or explicit",
      files: {
        ".github/workflows/gate.yml": 'steps: [{ "\\u0075ses": owner/action@v2 }]\n',
      },
    },
    {
      name: "explicit mapping key cannot hide a mutable reference",
      needle: "explicit YAML mapping keys",
      files: {
        ".github/workflows/gate.yml": "steps:\n  - ? uses\n    : owner/action@v3\n",
      },
    },
    {
      name: "anchored step cannot hide a mutable reference",
      needle: "decorated, inline, or explicit",
      files: {
        ".github/workflows/gate.yml": "steps:\n  - &shared uses: owner/action@main\n",
      },
    },
    {
      name: "tagged step cannot hide a mutable reference",
      needle: "decorated, inline, or explicit",
      files: {
        ".github/workflows/gate.yml": "steps:\n  - !!str uses: owner/action@main\n",
      },
    },
    {
      name: "explicit anchored key cannot hide a mutable reference",
      needle: "explicit YAML mapping keys",
      files: {
        ".github/workflows/gate.yml": "steps:\n  - ? &action-key uses\n    : owner/action@v3\n",
      },
    },
    {
      name: "alias-resolved key cannot hide a mutable reference",
      needle: "aliases are unsupported as mapping keys",
      files: {
        ".github/workflows/gate.yml":
          "env:\n  ACTION_KEY: &action-key uses\nsteps:\n  - *action-key: owner/action@main\n",
      },
    },
    {
      name: "explicit alias key cannot hide a mutable reference",
      needle: "explicit YAML mapping keys",
      files: {
        ".github/workflows/gate.yml":
          "env:\n  ACTION_KEY: &action-key uses\nsteps:\n  - ? *action-key\n    : owner/action@v1\n",
      },
    },
    {
      name: "continued quoted key cannot hide a mutable reference",
      needle: "continued quoted YAML scalars",
      files: {
        ".github/workflows/gate.yml":
          'steps:\n  - "us\\\n      es": owner/action@main\n',
      },
    },
    {
      name: "explicit continued key cannot hide a mutable reference",
      needle: "explicit YAML mapping keys",
      files: {
        ".github/workflows/gate.yml":
          'steps:\n  - ? "us\\\n        es"\n    : owner/action@main\n',
      },
    },
    {
      name: "YAML-only escape in quoted flow key cannot hide a mutable reference",
      needle: "quoted keys in inline YAML mappings",
      files: {
        ".github/workflows/gate.yml": 'steps: [{ "u\\x73es": owner/action@main }]\n',
      },
    },
    {
      name: "comments and quoted documentation are not workflow keys",
      valid: true,
      files: {
        ".github/workflows/gate.yml":
          'name: "documentation uses: examples"\n# uses: owner/action@main\nenv:\n  NOTE: "uses: is documentation" # uses: owner/action@v1\n',
      },
    },
  ];

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zuu-action-pins-"));
  try {
    for (const testCase of cases) {
      const fixture = path.join(temporaryRoot, testCase.name.replaceAll(/[^a-z0-9]+/gi, "-"));
      for (const [relative, contents] of Object.entries(testCase.files)) {
        writeFixture(fixture, relative, contents);
      }
      const result = scanRepository(fixture);
      if (testCase.valid) {
        if (result.failures.length) {
          throw new Error(`${testCase.name}: expected success, got ${result.failures.join("; ")}`);
        }
      } else if (
        result.failures.length === 0 ||
        !result.failures.some((failure) => failure.includes(testCase.needle))
      ) {
        throw new Error(
          `${testCase.name}: expected failure containing ${JSON.stringify(testCase.needle)}, got ${result.failures.join("; ")}`,
        );
      }
      console.log(`self-test: ${testCase.name}: passed`);
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  const gateResultCases = [
    {
      name: "all changed jobs including future Android 32-bit succeed",
      policyOutcome: "success",
      needs: {
        changes: {
          result: "success",
          outputs: { zuuli: "true", zuuallet_schema: "false" },
        },
        build: { result: "success", outputs: {} },
        rust_android_32: { result: "success", outputs: {} },
        zuuallet_schema: { result: "skipped", outputs: {} },
      },
    },
    {
      name: "independent schema selector is enforced",
      policyOutcome: "success",
      needs: {
        changes: {
          result: "success",
          outputs: { zuuli: "false", zuuallet_schema: "true" },
        },
        build: { result: "skipped", outputs: {} },
        zuuallet_schema: { result: "success", outputs: {} },
      },
    },
    {
      name: "soft-failed policy outcome is rejected",
      policyOutcome: "failure",
      needle: "gate-local policy recheck did not pass",
      needs: {},
    },
    {
      name: "failed ordinary dependency is rejected",
      policyOutcome: "success",
      needle: "required job build must be success, got failure",
      needs: {
        changes: {
          result: "success",
          outputs: { zuuli: "true", zuuallet_schema: "false" },
        },
        build: { result: "failure", outputs: {} },
      },
    },
    {
      name: "schema result cannot follow the general selector",
      policyOutcome: "success",
      needle: "required job zuuallet_schema must be skipped, got success",
      needs: {
        changes: {
          result: "success",
          outputs: { zuuli: "true", zuuallet_schema: "false" },
        },
        zuuallet_schema: { result: "success", outputs: {} },
      },
    },
    {
      name: "invalid change selector fails closed",
      policyOutcome: "success",
      needle: "invalid or missing ZUULI change-detector output",
      needs: {
        changes: {
          result: "success",
          outputs: { zuuli: "", zuuallet_schema: "false" },
        },
      },
    },
  ];
  for (const testCase of gateResultCases) {
    let error = null;
    try {
      verifyGateResults(testCase.policyOutcome, JSON.stringify(testCase.needs));
    } catch (caught) {
      error = caught;
    }
    if (testCase.needle) {
      if (!error?.message.includes(testCase.needle)) {
        throw new Error(
          `${testCase.name}: expected failure containing ${JSON.stringify(testCase.needle)}, got ${error?.message ?? "success"}`,
        );
      }
    } else if (error) {
      throw new Error(`${testCase.name}: expected success, got ${error.message}`);
    }
    console.log(`self-test: gate verdict: ${testCase.name}: passed`);
  }
  const currentWorkflowMutations = runCurrentWorkflowMutationTests(repoRoot);
  console.log(
    `self-test: ${cases.length} source-policy, ${gateResultCases.length} gate-verdict, ` +
      `and ${currentWorkflowMutations} current-workflow mutation case(s) passed.`,
  );
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const args = process.argv.slice(2);
const mode = args[0];
if (
  args.length > 1 ||
  (args.length === 1 && !["--self-test", "--verify-gate-results"].includes(mode))
) {
  console.error(
    "usage: scripts/check-github-actions-pins.mjs [--self-test|--verify-gate-results]",
  );
  process.exit(2);
}

if (mode === "--self-test") {
  runSelfTest(repoRoot);
} else if (mode === "--verify-gate-results") {
  try {
    const verdicts = verifyGateResults(
      process.env.POLICY_OUTCOME,
      process.env.REQUIRED_JOBS_JSON,
    );
    console.log(`The full-stack gate passed: ${verdicts.join(", ")}`);
  } catch (error) {
    console.error(`Required-gate verdict failed: ${error.message}`);
    process.exit(1);
  }
} else {
  const result = scanRepository(repoRoot);
  if (result.failures.length) {
    console.error("GitHub Actions fail-closed policy failed:");
    for (const failure of result.failures) console.error(`- ${failure}`);
    console.error(
      `${result.failures.length} failure(s); scanned ${result.scannedFiles} workflow/action file(s) and ${result.externalReferences} external reference(s).`,
    );
    process.exit(1);
  }
  console.log(
    "GitHub Actions policy passed: every external action/reusable workflow is immutably pinned, " +
      `and every required-gate dependency is fail-closed and consumed (${result.externalReferences} ` +
      `external reference(s), ${result.scannedFiles} file(s)).`,
  );
}
