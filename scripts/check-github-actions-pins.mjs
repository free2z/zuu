#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
const EXTERNAL_USES = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@([^@\s]+)$/;

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

function gateResultInputs(lines, gateStart, gateEnd) {
  const resultInputs = new Map();
  const runBlocks = [];

  for (let index = gateStart + 1; index < gateEnd; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line || line.error) continue;
    const entry = mappingEntry(line.text, "gate property");
    if (entry.error) continue;

    if (entry.key === "env" && !entry.value) {
      const envIndent = line.indent;
      for (let childIndex = index + 1; childIndex < gateEnd; childIndex += 1) {
        const child = workflowLine(lines[childIndex]);
        if (!child) continue;
        if (child.error || child.indent <= envIndent) break;
        const envEntry = mappingEntry(child.text, "gate environment");
        if (envEntry.error) continue;
        const expression = envEntry.value.match(
          /^\$\{\{\s*needs\.([A-Za-z_][A-Za-z0-9_-]*)\.result\s*\}\}$/,
        );
        if (!expression) continue;
        if (!resultInputs.has(expression[1])) resultInputs.set(expression[1], new Set());
        resultInputs.get(expression[1]).add(envEntry.key);
      }
    }

    if (entry.key === "run") {
      const block = [];
      if (entry.value && !/^[|>][+-]?[1-9]?$/.test(entry.value)) {
        block.push(entry.value);
      } else {
        for (let childIndex = index + 1; childIndex < gateEnd; childIndex += 1) {
          const child = workflowLine(lines[childIndex]);
          if (!child) continue;
          if (child.error || child.indent <= line.indent) break;
          if (!child.text.trimStart().startsWith("#")) block.push(child.text);
        }
      }
      runBlocks.push(block.join("\n"));
    }
  }
  return { resultInputs, runText: runBlocks.join("\n") };
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

  const inspection = gateResultInputs(lines, gate.start, gate.end);
  for (const dependency of parsedNeeds.values) {
    const variables = inspection.resultInputs.get(dependency);
    if (!variables?.size) {
      failures.push(
        `${relativeFile}:${gate.start + 1}: gate dependency ${dependency} must expose ` +
          `needs.${dependency}.result through a gate-step environment variable`,
      );
      continue;
    }
    const consumed = [...variables].some((variable) => {
      const escaped = variable.replaceAll(/[$()*+.?[\]^{|}]/g, "\\$&");
      return new RegExp(`\\$(?:\\{${escaped}\\}|${escaped}(?![A-Za-z0-9_]))`).test(
        inspection.runText,
      );
    });
    if (!consumed) {
      failures.push(
        `${relativeFile}:${gate.start + 1}: gate result for ${dependency} is not consumed by a gate run step`,
      );
    }
  }

  return failures;
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

function runSelfTest() {
  const fullSha = "0123456789abcdef0123456789abcdef01234567";
  const gateFixture = (contents) => ({
    ".github/workflows/zuuli.yml": contents,
  });
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
    "      - name: inspect every dependency",
    "        env:",
    "          BUILD_RESULT: ${{ needs.build.result }}",
    "        run: |",
    '          [ "$BUILD_RESULT" = "success" ]',
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
      name: "every gate dependency must expose its result",
      needle: "gate dependency advisory must expose needs.advisory.result",
      files: gateFixture(
        validGateWorkflow.replace(
          "    needs: [build]\n",
          "    needs: [build, advisory]\n",
        ),
      ),
    },
    {
      name: "every exposed dependency result must be consumed",
      needle: "gate result for advisory is not consumed",
      files: gateFixture(
        validGateWorkflow
          .replace("    needs: [build]\n", "    needs: [build, advisory]\n")
          .replace(
            "          BUILD_RESULT: ${{ needs.build.result }}\n",
            "          BUILD_RESULT: ${{ needs.build.result }}\n          ADVISORY_RESULT: ${{ needs.advisory.result }}\n",
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
  console.log(`self-test: ${cases.length} GitHub Actions policy case(s) passed.`);
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--self-test")) {
  console.error("usage: scripts/check-github-actions-pins.mjs [--self-test]");
  process.exit(2);
}

if (args[0] === "--self-test") {
  runSelfTest();
} else {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDirectory, "..");
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
