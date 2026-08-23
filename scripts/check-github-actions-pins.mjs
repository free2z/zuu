#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
const POLICY_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const EXTERNAL_USES =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@([^@\s]+)$/;
const REQUIRED_WORKFLOW_PATH = ".github/workflows/zuuli.yml";
const GATE_CHECKOUT_REFERENCE =
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const GATE_POLICY_SELF_TEST_COMMAND =
  "node scripts/check-github-actions-pins.mjs --self-test";
const GATE_POLICY_COMMAND = "node scripts/check-github-actions-pins.mjs";
const GATE_VERDICT_COMMAND =
  "node scripts/check-github-actions-pins.mjs --verify-gate-results";
const REQUIRED_NATIVE_CLIPPY_JOB_LINES = [
  "  rust_native_clippy:",
  "    name: Rust / native lints (${{ matrix.target_os }})",
  "    needs: changes",
  "    if: needs.changes.outputs.zuuli == 'true' || needs.changes.outputs.zuuallet_schema == 'true'",
  "    timeout-minutes: 90",
  "    strategy:",
  "      fail-fast: false",
  "      matrix:",
  "        include:",
  "          - os: macos-latest",
  "            target_os: macos",
  "          - os: windows-latest",
  "            target_os: windows",
  "    runs-on: ${{ matrix.os }}",
  "    steps:",
  `      - uses: ${GATE_CHECKOUT_REFERENCE} # v7.0.1`,
  "      - name: Fetch librustzcash submodule",
  "        run: git submodule update --init z/zcash/librustzcash",
  "      - name: Resolve the pinned Rust toolchain",
  "        id: rust_toolchain",
  "        shell: bash",
  "        run: |",
  "          set -euo pipefail",
  "          version=$(scripts/check-rust-toolchain.sh --print-channel)",
  '          echo "version=$version" >> "$GITHUB_OUTPUT"',
  "      - uses: dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c # stable",
  "        with:",
  "          toolchain: ${{ steps.rust_toolchain.outputs.version }}",
  "          components: clippy",
  "      - uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2",
  "        with:",
  "          workspaces: |",
  "            wallet/plugins/tauri-plugin-zcash",
  "            wallet/zuuli/src-tauri",
  "            wallet/zuuallet/src-tauri",
  "          key: zuuli-native-clippy-${{ matrix.target_os }}",
  "      - name: Prove native target selection and -D warnings",
  "        shell: bash",
  '        run: scripts/check-rust-clippy.sh --self-test "${{ matrix.target_os }}"',
  "      - name: Lint every Rust crate under wallet/ at -D warnings",
  "        shell: bash",
  "        run: scripts/check-rust-clippy.sh",
];
const REQUIRED_NATIVE_CLIPPY_INPUTS = [
  "Cargo.toml",
  "Cargo.lock",
  ".cargo/config.toml",
  "clippy.toml",
  ".clippy.toml",
  "wallet/Cargo.toml",
  "wallet/Cargo.lock",
  "wallet/.cargo/config.toml",
  "wallet/clippy.toml",
  "wallet/.clippy.toml",
  "wallet/future-crate/src/lib.rs",
  "wallet/future-crate/Cargo.toml",
  "wallet/future-crate/Cargo.lock",
  "wallet/future-crate/.cargo/config.toml",
  "wallet/future-crate/clippy.toml",
  "wallet/future-crate/.clippy.toml",
];
// Environment inheritance can alter Bash and Node before an exact `run:` block
// begins. Required jobs therefore accept only these reviewed data inputs; every
// other workflow/job/step environment entry fails closed.
const REQUIRED_WORKFLOW_ENVIRONMENT = new Map([
  ["CARGO_TERM_COLOR", "always"],
  ["RUST_BACKTRACE", "1"],
]);
const REQUIRED_JOB_ENVIRONMENTS = new Map([
  [
    "zuuallet_schema",
    new Map([["CARGO_TARGET_DIR", "${{ github.workspace }}/target"]]),
  ],
]);
const REQUIRED_JOB_DEFAULT_WORKING_DIRECTORIES = new Map([
  ["frontend", "wallet/zuuli"],
]);
const REQUIRED_STEP_ENVIRONMENTS = new Map([
  [
    "changes\0Detect release-impacting ZUULI changes",
    new Map([
      [
        "BASE_SHA",
        "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before }}",
      ],
    ]),
  ],
  [
    "rust_app\0Build ZUULI Tauri backend",
    new Map([
      [
        "TAURI_SCHEMA_GENERATION_NONCE",
        "${{ github.run_id }}-${{ github.run_attempt }}",
      ],
      [
        "TAURI_PERMISSION_GENERATION_NONCE",
        "${{ github.run_id }}-${{ github.run_attempt }}",
      ],
    ]),
  ],
  [
    "zuuallet_schema\0Regenerate Zuuallet permissions and target schema",
    new Map([
      [
        "TAURI_SCHEMA_GENERATION_NONCE",
        "${{ github.run_id }}-${{ github.run_attempt }}",
      ],
      [
        "TAURI_PERMISSION_GENERATION_NONCE",
        "${{ github.run_id }}-${{ github.run_attempt }}",
      ],
    ]),
  ],
  [
    "gate\0Verify required jobs succeeded or legitimately skipped",
    new Map([
      ["POLICY_OUTCOME", "${{ steps.policy.outcome }}"],
      ["REQUIRED_JOBS_JSON", "${{ toJSON(needs) }}"],
    ]),
  ],
]);
const REQUIRED_STEP_WORKING_DIRECTORIES = new Map([
  ["rust_clippy\0Verify pinned Linux build image", "/"],
  ["rust_plugin\0Verify pinned Linux build image", "/"],
  ["rust_app\0Verify pinned Linux build image", "/"],
  ["zuuallet_schema\0Verify pinned Linux build image", "/"],
]);

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
      error:
        "explicit YAML mapping keys are unsupported; put `uses:` on its own line",
    };
  }
  if (/^\s*(?:-\s*)?"(?:\\.|[^"])*\\\s*$/.test(line)) {
    return {
      error:
        "continued quoted YAML scalars are unsupported because they can construct `uses`",
    };
  }
  if (/[\[,{]\s*(?:"(?:\\.|[^"])*"|'(?:''|[^'])*')\s*:/.test(keySearchLine)) {
    return {
      error:
        "quoted keys in inline YAML mappings are unsupported because they can encode `uses`",
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
  const provenance =
    comment < 0 ? "" : scalar.slice(comment).replace(/^\s+#/, "").trim();
  return ref ? { provenance, ref } : { error: "empty `uses:` value" };
}

function shellCasePatternMatches(pattern, value) {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${regex}$`).test(value);
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

function defaultRunExecutionFailures(
  relativeFile,
  lines,
  property,
  end,
  owner,
  expectedWorkingDirectory,
) {
  const failures = [];
  if (property.value) {
    failures.push(
      `${relativeFile}:${property.index + 1}: ${owner} defaults must use a canonical block mapping`,
    );
    return failures;
  }

  let run = null;
  for (let index = property.index + 1; index < end; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line) continue;
    if (line.error) {
      failures.push(`${relativeFile}:${index + 1}: ${line.error}`);
      continue;
    }
    if (line.indent <= property.indent) break;
    if (line.indent !== property.indent + 2) continue;
    const entry = mappingEntry(line.text, `${owner} defaults property`);
    if (entry.error || entry.key !== "run" || run) {
      failures.push(
        `${relativeFile}:${index + 1}: ${owner} defaults may contain exactly one canonical run mapping`,
      );
      continue;
    }
    run = {
      index,
      indent: line.indent,
      value: entry.value,
    };
  }

  if (!run || run.value) {
    failures.push(
      `${relativeFile}:${property.index + 1}: ${owner} defaults.run must use a canonical block mapping`,
    );
    return failures;
  }

  const runProperties = new Map();
  for (let index = run.index + 1; index < end; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line) continue;
    if (line.error) {
      failures.push(`${relativeFile}:${index + 1}: ${line.error}`);
      continue;
    }
    if (line.indent <= run.indent) break;
    if (line.indent !== run.indent + 2) {
      failures.push(
        `${relativeFile}:${index + 1}: ${owner} defaults.run must use canonical indentation`,
      );
      continue;
    }
    const entry = mappingEntry(line.text, `${owner} defaults.run property`);
    if (
      entry.error ||
      !["shell", "working-directory"].includes(entry.key) ||
      runProperties.has(entry.key)
    ) {
      failures.push(
        `${relativeFile}:${index + 1}: ${owner} defaults.run contains an unsupported or duplicate property`,
      );
      continue;
    }
    runProperties.set(entry.key, { index, value: entry.value });
  }

  const shell = runProperties.get("shell");
  if (shell && shell.value !== "bash") {
    failures.push(
      `${relativeFile}:${shell.index + 1}: ${owner} defaults.run.shell must be exactly bash`,
    );
  }
  const workingDirectory = runProperties.get("working-directory");
  if ((workingDirectory?.value ?? undefined) !== expectedWorkingDirectory) {
    failures.push(
      `${relativeFile}:${(workingDirectory?.index ?? property.index) + 1}: ${owner} defaults.run.working-directory differs from its exact reviewed value`,
    );
  }
  return failures;
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

function policyJobSteps(relativeFile, lines, job, failures, label) {
  const stepsProperty = job.properties.get("steps");
  if (!stepsProperty || stepsProperty.value) {
    failures.push(
      `${relativeFile}:${job.start + 1}: ${label} steps must use a block sequence`,
    );
    return [];
  }

  const firstStepLine = lines
    .slice(stepsProperty.index + 1, job.end)
    .map((line, offset) => ({
      index: stepsProperty.index + 1 + offset,
      line: workflowLine(line),
    }))
    .find(({ line }) => line && !line.error);
  if (
    !firstStepLine ||
    firstStepLine.line.indent !== 6 ||
    !firstStepLine.line.text.startsWith("- ")
  ) {
    failures.push(
      `${relativeFile}:${stepsProperty.index + 1}: ${label} steps must begin with a canonical block-sequence entry`,
    );
    return [];
  }

  const steps = [];
  for (let index = stepsProperty.index + 1; index < job.end; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line || line.error || line.indent !== 6) continue;
    if (!line.text.startsWith("- ")) {
      failures.push(
        `${relativeFile}:${index + 1}: ${label} steps must use canonical block-sequence entries`,
      );
      continue;
    }
    const entry = mappingEntry(line.text.slice(2), `${label} step`);
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
    step.end = steps[position + 1]?.start ?? job.end;
    for (let index = step.start + 1; index < step.end; index += 1) {
      const line = workflowLine(lines[index]);
      if (!line || line.error || line.indent !== 8) continue;
      const entry = mappingEntry(line.text, `${label} step property`);
      if (entry.error) {
        failures.push(`${relativeFile}:${index + 1}: ${entry.error}`);
        continue;
      }
      if (step.properties.has(entry.key)) {
        failures.push(
          `${relativeFile}:${index + 1}: duplicate ${entry.key} property on ${label} step`,
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

function requiredContainerInjectionFailures(relativeFile, lines, job) {
  const failures = [];
  const container = job.properties.get("container");
  if (!container) return failures;
  if (container.value) {
    failures.push(
      `${relativeFile}:${container.index + 1}: required job ${job.id} container must use a canonical block mapping`,
    );
    return failures;
  }

  for (let index = container.index + 1; index < job.end; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line) continue;
    if (line.error) {
      failures.push(`${relativeFile}:${index + 1}: ${line.error}`);
      continue;
    }
    if (line.indent <= container.indent) break;
    if (line.indent !== container.indent + 2) continue;
    const entry = mappingEntry(
      line.text,
      `required job ${job.id} container property`,
    );
    if (entry.error) {
      failures.push(`${relativeFile}:${index + 1}: ${entry.error}`);
    } else if (["env", "options"].includes(entry.key)) {
      failures.push(
        `${relativeFile}:${index + 1}: required job ${job.id} container cannot inject environment or runtime options`,
      );
    }
  }
  return failures;
}

function requiredJobExecutionFailures(relativeFile, lines, job) {
  const failures = [];
  const requiredMainWorkflow =
    relativeFile.split(path.sep).join("/") === REQUIRED_WORKFLOW_PATH;
  const defaults = job.properties.get("defaults");
  const expectedDefaultWorkingDirectory = requiredMainWorkflow
    ? REQUIRED_JOB_DEFAULT_WORKING_DIRECTORIES.get(job.id)
    : undefined;
  if (defaults) {
    failures.push(
      ...defaultRunExecutionFailures(
        relativeFile,
        lines,
        defaults,
        job.end,
        `required job ${job.id}`,
        expectedDefaultWorkingDirectory,
      ),
    );
  } else if (expectedDefaultWorkingDirectory !== undefined) {
    failures.push(
      `${relativeFile}:${job.start + 1}: required job ${job.id} defaults.run.working-directory differs from its exact reviewed value`,
    );
  }
  const jobEnvironment = job.properties.get("env");
  const expectedJobEnvironment = requiredMainWorkflow
    ? (REQUIRED_JOB_ENVIRONMENTS.get(job.id) ?? new Map())
    : new Map();
  if (jobEnvironment) {
    const actual = environmentMap(
      relativeFile,
      lines,
      jobEnvironment,
      job.end,
      failures,
      `required job ${job.id}`,
    );
    failures.push(
      ...exactEnvironmentFailures(
        relativeFile,
        jobEnvironment.index,
        actual,
        expectedJobEnvironment,
        `required job ${job.id}`,
      ),
    );
  } else if (expectedJobEnvironment.size) {
    failures.push(
      `${relativeFile}:${job.start + 1}: required job ${job.id} environment differs from its exact reviewed allowlist`,
    );
  }
  failures.push(
    ...requiredContainerInjectionFailures(relativeFile, lines, job),
  );

  if (!job.properties.has("steps")) return failures;
  const steps = policyJobSteps(
    relativeFile,
    lines,
    job,
    failures,
    `required job ${job.id}`,
  );
  for (const step of steps) {
    const shell = step.properties.get("shell");
    if (shell && shell.value !== "bash") {
      failures.push(
        `${relativeFile}:${shell.index + 1}: required job ${job.id} step shell must be exactly bash`,
      );
    }
    const stepEnvironmentProperty = step.properties.get("env");
    const stepName = step.properties.get("name")?.value ?? "";
    const stepScope = `${job.id}\0${stepName}`;
    const expectedStepEnvironment = requiredMainWorkflow
      ? (REQUIRED_STEP_ENVIRONMENTS.get(stepScope) ?? new Map())
      : new Map();
    if (stepEnvironmentProperty) {
      const actual = environmentMap(
        relativeFile,
        lines,
        stepEnvironmentProperty,
        step.end,
        failures,
        `required job ${job.id} step`,
      );
      failures.push(
        ...exactEnvironmentFailures(
          relativeFile,
          stepEnvironmentProperty.index,
          actual,
          expectedStepEnvironment,
          `required job ${job.id} step ${stepName || "<unnamed>"}`,
        ),
      );
    } else if (expectedStepEnvironment.size) {
      failures.push(
        `${relativeFile}:${step.start + 1}: required job ${job.id} step ${stepName || "<unnamed>"} environment differs from its exact reviewed allowlist`,
      );
    }
    const workingDirectory = step.properties.get("working-directory");
    const expectedWorkingDirectory = requiredMainWorkflow
      ? REQUIRED_STEP_WORKING_DIRECTORIES.get(stepScope)
      : undefined;
    if ((workingDirectory?.value ?? undefined) !== expectedWorkingDirectory) {
      failures.push(
        `${relativeFile}:${(workingDirectory?.index ?? step.start) + 1}: required job ${job.id} step ${stepName || "<unnamed>"} working-directory differs from its exact reviewed value`,
      );
    }
  }
  return failures;
}

function environmentMap(relativeFile, lines, property, end, failures, owner) {
  const environment = new Map();
  if (property.value) {
    failures.push(
      `${relativeFile}:${property.index + 1}: ${owner} environment must use a canonical block mapping`,
    );
    return environment;
  }

  for (let index = property.index + 1; index < end; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line) continue;
    if (line.error) {
      failures.push(`${relativeFile}:${index + 1}: ${line.error}`);
      continue;
    }
    if (line.indent <= property.indent) break;
    if (line.indent !== property.indent + 2) {
      failures.push(
        `${relativeFile}:${index + 1}: ${owner} environment must use canonical indentation`,
      );
      continue;
    }
    const entry = mappingEntry(line.text, `${owner} environment`);
    if (entry.error) {
      failures.push(`${relativeFile}:${index + 1}: ${entry.error}`);
      continue;
    }
    if (environment.has(entry.key)) {
      failures.push(
        `${relativeFile}:${index + 1}: duplicate ${owner} environment key ${entry.key}`,
      );
    } else {
      environment.set(entry.key, entry.value);
    }
  }
  return environment;
}

function stepEnvironment(relativeFile, lines, step, failures) {
  const property = step.properties.get("env");
  if (!property) return new Map();
  return environmentMap(
    relativeFile,
    lines,
    property,
    step.end,
    failures,
    "gate verdict",
  );
}

function exactEnvironmentFailures(
  relativeFile,
  location,
  actual,
  expected,
  owner,
) {
  const failures = [];
  if (
    actual.size !== expected.size ||
    [...expected].some(([key, value]) => actual.get(key) !== value)
  ) {
    failures.push(
      `${relativeFile}:${location + 1}: ${owner} environment differs from its exact reviewed allowlist`,
    );
  }
  return failures;
}

function hasExactKeys(map, keys) {
  return map.size === keys.length && keys.every((key) => map.has(key));
}

function requiredGateControlFailures(relativeFile, lines, gate) {
  const failures = [];
  const steps = policyJobSteps(relativeFile, lines, gate, failures, "gate");
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

  const policyCommands = blockScalarCommands(
    lines,
    policy.properties.get("run") ?? {
      index: policy.start,
      indent: 8,
      value: "",
    },
    policy.end,
  );
  if (
    !hasExactKeys(policy.properties, ["name", "id", "run"]) ||
    policy.properties.get("name")?.value !==
      "Recheck immutable actions and fail-closed required jobs" ||
    policy.properties.get("id")?.value !== "policy" ||
    policy.properties.get("run")?.value !== "|" ||
    policyCommands.length !== 2 ||
    policyCommands[0] !== GATE_POLICY_SELF_TEST_COMMAND ||
    policyCommands[1] !== GATE_POLICY_COMMAND
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
    verdict.properties.get("run") ?? {
      index: verdict.start,
      indent: 8,
      value: "",
    },
    verdict.end,
  );
  if (
    !hasExactKeys(verdict.properties, ["name", "env", "run"]) ||
    verdict.properties.get("name")?.value !==
      "Verify required jobs succeeded or legitimately skipped" ||
    verdict.properties.get("run")?.value !== "|" ||
    !hasExactKeys(verdictEnvironment, [
      "POLICY_OUTCOME",
      "REQUIRED_JOBS_JSON",
    ]) ||
    verdictEnvironment.get("POLICY_OUTCOME") !==
      "${{ steps.policy.outcome }}" ||
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

function requiredChangesControlFailures(relativeFile, lines, changes) {
  const failures = [];
  const steps = policyJobSteps(
    relativeFile,
    lines,
    changes,
    failures,
    "changes",
  );
  const policySteps = steps.filter(
    (step) =>
      step.properties.get("name")?.value ===
      "Verify immutable actions and fail-closed required jobs",
  );
  if (policySteps.length !== 1) {
    failures.push(
      `${relativeFile}:${changes.start + 1}: changes must contain exactly one immutable-actions policy step`,
    );
    return failures;
  }

  const [policy] = policySteps;
  const commands = blockScalarCommands(
    lines,
    policy.properties.get("run") ?? {
      index: policy.start,
      indent: 8,
      value: "",
    },
    policy.end,
  );
  if (
    !hasExactKeys(policy.properties, ["name", "run"]) ||
    policy.properties.get("run")?.value !== "|" ||
    commands.length !== 2 ||
    commands[0] !== GATE_POLICY_SELF_TEST_COMMAND ||
    commands[1] !== GATE_POLICY_COMMAND
  ) {
    failures.push(
      `${relativeFile}:${policy.start + 1}: changes policy step must exactly self-test and enforce the current-source policy`,
    );
  }
  return failures;
}

function policyWorkflowJobs(relativeFile, lines, failures) {
  const topLevel = [];
  const workflowDefaults = [];
  const workflowEnvironments = [];

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
    } else if (entry.key === "defaults") {
      workflowDefaults.push({ index, indent: 0, value: entry.value });
    } else if (entry.key === "env") {
      workflowEnvironments.push({ index, indent: 0, value: entry.value });
    }
  }

  if (workflowDefaults.length > 1) {
    failures.push(`${relativeFile}: required workflow cannot repeat defaults`);
  }
  for (const defaults of workflowDefaults) {
    failures.push(
      ...defaultRunExecutionFailures(
        relativeFile,
        lines,
        defaults,
        lines.length,
        "required workflow",
        undefined,
      ),
    );
  }
  if (workflowEnvironments.length > 1) {
    failures.push(`${relativeFile}: required workflow cannot repeat env`);
  }
  const expectedWorkflowEnvironment =
    relativeFile.split(path.sep).join("/") === REQUIRED_WORKFLOW_PATH
      ? REQUIRED_WORKFLOW_ENVIRONMENT
      : new Map();
  for (const environment of workflowEnvironments) {
    const actual = environmentMap(
      relativeFile,
      lines,
      environment,
      lines.length,
      failures,
      "required workflow",
    );
    failures.push(
      ...exactEnvironmentFailures(
        relativeFile,
        environment.index,
        actual,
        expectedWorkflowEnvironment,
        "required workflow",
      ),
    );
  }
  if (!workflowEnvironments.length && expectedWorkflowEnvironment.size) {
    failures.push(
      `${relativeFile}: required workflow environment differs from its exact reviewed allowlist`,
    );
  }

  if (!topLevel.length) {
    failures.push(
      `${relativeFile}: required workflow must contain a jobs block mapping`,
    );
    return new Map();
  }
  if (topLevel.length !== 1) {
    failures.push(
      `${relativeFile}: workflow must contain exactly one jobs mapping`,
    );
    return new Map();
  }
  const jobsEntry = topLevel[0];
  if (jobsEntry.value) {
    failures.push(
      `${relativeFile}:${jobsEntry.index + 1}: jobs must use a block mapping so required-gate policy can inspect it`,
    );
    return new Map();
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
      failures.push(
        `${relativeFile}:${index + 1}: duplicate job definition: ${entry.key}`,
      );
      continue;
    }
    jobs.set(entry.key, { id: entry.key, start: index, properties: new Map() });
  }

  const orderedJobs = [...jobs.values()].sort(
    (left, right) => left.start - right.start,
  );
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
      job.properties.set(entry.key, {
        index,
        indent: 4,
        value: entry.value,
      });
    }
  }

  return jobs;
}

function requiredJobUsesReference(relativeFile, property, failures) {
  const parsed = usesFromLine(`uses: ${property.value}`);
  if (!parsed || parsed.error) {
    failures.push(
      `${relativeFile}:${property.index + 1}: required reusable workflow reference is invalid: ${parsed?.error ?? property.value}`,
    );
    return null;
  }
  return parsed.ref;
}

function requiredReusableWorkflowFailures(
  repoRoot,
  targetFile,
  validated = new Set(),
  active = new Set(),
) {
  const failures = [];
  const canonical = fs.realpathSync(targetFile);
  const relativeFile = path.relative(repoRoot, canonical);
  if (active.has(canonical)) {
    failures.push(
      `${relativeFile}: required reusable workflow cycle is forbidden`,
    );
    return failures;
  }
  if (validated.has(canonical)) return failures;

  active.add(canonical);
  const lines = fs.readFileSync(canonical, "utf8").split(/\r?\n/);
  const jobs = policyWorkflowJobs(relativeFile, lines, failures);
  for (const job of jobs.values()) {
    failures.push(...requiredJobExecutionFailures(relativeFile, lines, job));
    const softFail = job.properties.get("continue-on-error");
    if (softFail) {
      failures.push(
        `${relativeFile}:${softFail.index + 1}: job-level continue-on-error is forbidden in required reusable workflow job ${job.id}`,
      );
    }

    const uses = job.properties.get("uses");
    if (!uses) continue;
    const reference = requiredJobUsesReference(relativeFile, uses, failures);
    if (!reference) continue;
    if (!/^\.\/\.github\/workflows\/[^/]+\.ya?ml$/.test(reference)) {
      failures.push(
        `${relativeFile}:${uses.index + 1}: required reusable workflow job ${job.id} must call a repository-local workflow`,
      );
      continue;
    }
    const target = localTarget(repoRoot, reference);
    if (target.error) {
      failures.push(`${relativeFile}:${uses.index + 1}: ${target.error}`);
      continue;
    }
    failures.push(
      ...requiredReusableWorkflowFailures(
        repoRoot,
        target.file,
        validated,
        active,
      ),
    );
  }
  active.delete(canonical);
  validated.add(canonical);
  return failures;
}

function nativeClippySelectorFailures(relativeFile, lines, changes) {
  const failures = [];
  const steps = policyJobSteps(
    relativeFile,
    lines,
    changes,
    failures,
    "changes",
  );
  const detectors = steps.filter(
    (step) =>
      step.properties.get("name")?.value ===
      "Detect release-impacting ZUULI changes",
  );
  if (detectors.length !== 1) {
    failures.push(
      `${relativeFile}:${changes.start + 1}: changes must contain exactly one release-impacting change detector`,
    );
    return failures;
  }

  const detector = detectors[0];
  const run = detector.properties.get("run");
  if (run?.value !== "|") {
    failures.push(
      `${relativeFile}:${detector.start + 1}: release-impacting change detector must use a block run script`,
    );
    return failures;
  }
  const body = lines.slice(run.index + 1, detector.end).join("\n");
  const arms = new Map();
  for (const match of body.matchAll(
    /^\s*case "\$file" in\s*\n\s*([^\n)]+)\)\s*\n\s*(zuuli|zuuallet_schema)=true\s*\n\s*;;\s*\n\s*esac\s*$/gm,
  )) {
    const output = match[2];
    if (arms.has(output)) {
      failures.push(
        `${relativeFile}:${detector.start + 1}: release-impacting change detector has duplicate ${output} selector arms`,
      );
    } else {
      arms.set(
        output,
        match[1].split("|").map((pattern) => pattern.trim()),
      );
    }
  }
  if (!arms.has("zuuli") || !arms.has("zuuallet_schema")) {
    failures.push(
      `${relativeFile}:${detector.start + 1}: release-impacting change detector must retain both native lint selector arms`,
    );
    return failures;
  }

  const patterns = [...arms.values()].flat();
  for (const input of REQUIRED_NATIVE_CLIPPY_INPUTS) {
    if (!patterns.some((pattern) => shellCasePatternMatches(pattern, input))) {
      failures.push(
        `${relativeFile}:${detector.start + 1}: native clippy input must select at least one native lint path: ${input}`,
      );
    }
  }
  return failures;
}

function gatePolicyFailures(repoRoot, relativeFile, lines) {
  const failures = [];
  const jobs = policyWorkflowJobs(relativeFile, lines, failures);

  const gate = jobs.get("gate");
  if (!gate) {
    failures.push(
      `${relativeFile}: required workflow must contain the gate job`,
    );
    return failures;
  }
  const needsProperty = gate.properties.get("needs");
  if (!needsProperty) {
    failures.push(
      `${relativeFile}:${gate.start + 1}: required gate must declare needs`,
    );
    return failures;
  }
  const parsedNeeds = parseGateNeeds(lines, needsProperty.index, 4);
  if (parsedNeeds.error) {
    failures.push(
      `${relativeFile}:${needsProperty.index + 1}: ${parsedNeeds.error}`,
    );
    return failures;
  }

  for (const dependency of parsedNeeds.values) {
    if (!jobs.has(dependency)) {
      failures.push(
        `${relativeFile}:${needsProperty.index + 1}: gate depends on undefined job ${dependency}`,
      );
    }
  }

  const enforceNativeClippy =
    path.resolve(repoRoot) === POLICY_REPO_ROOT &&
    relativeFile.split(path.sep).join("/") === REQUIRED_WORKFLOW_PATH;
  if (
    enforceNativeClippy &&
    !parsedNeeds.values.includes("rust_native_clippy")
  ) {
    failures.push(
      `${relativeFile}:${needsProperty.index + 1}: gate must await rust_native_clippy`,
    );
  }

  const nativeClippy = jobs.get("rust_native_clippy");
  if (enforceNativeClippy && !nativeClippy) {
    failures.push(
      `${relativeFile}: required workflow must contain rust_native_clippy`,
    );
  } else if (enforceNativeClippy) {
    const actualNativeClippyJobLines = lines
      .slice(nativeClippy.start, nativeClippy.end)
      .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
      .map((line) => line.trimEnd());
    if (
      JSON.stringify(actualNativeClippyJobLines) !==
      JSON.stringify(REQUIRED_NATIVE_CLIPPY_JOB_LINES)
    ) {
      failures.push(
        `${relativeFile}:${nativeClippy.start + 1}: rust_native_clippy must match the exact current-source native job contract`,
      );
    }

    const expectedProperties = new Map([
      ["name", "Rust / native lints (${{ matrix.target_os }})"],
      ["needs", "changes"],
      [
        "if",
        "needs.changes.outputs.zuuli == 'true' || needs.changes.outputs.zuuallet_schema == 'true'",
      ],
      ["timeout-minutes", "90"],
      ["runs-on", "${{ matrix.os }}"],
    ]);
    for (const [property, expected] of expectedProperties) {
      if (nativeClippy.properties.get(property)?.value !== expected) {
        failures.push(
          `${relativeFile}:${nativeClippy.start + 1}: rust_native_clippy ${property} differs from its required value`,
        );
      }
    }

    const nativeLines = lines.slice(nativeClippy.start, nativeClippy.end);
    const targetOperatingSystems = nativeLines
      .map((line) => /^\s+target_os:\s+(\S+)\s*$/.exec(line)?.[1])
      .filter(Boolean);
    const runnerOperatingSystems = nativeLines
      .map((line) => /^\s+- os:\s+(\S+)\s*$/.exec(line)?.[1])
      .filter(Boolean);
    if (
      JSON.stringify(targetOperatingSystems) !==
        JSON.stringify(["macos", "windows"]) ||
      JSON.stringify(runnerOperatingSystems) !==
        JSON.stringify(["macos-latest", "windows-latest"])
    ) {
      failures.push(
        `${relativeFile}:${nativeClippy.start + 1}: rust_native_clippy must use the exact macOS/Windows native matrix`,
      );
    }

    const nativeSteps = policyJobSteps(
      relativeFile,
      lines,
      nativeClippy,
      failures,
      "rust_native_clippy",
    );
    const stepsByName = (name) =>
      nativeSteps.filter((step) => step.properties.get("name")?.value === name);
    const selfTests = stepsByName(
      "Prove native target selection and -D warnings",
    );
    const selfTest = selfTests[0];
    if (
      selfTests.length !== 1 ||
      !hasExactKeys(selfTest?.properties ?? new Map(), [
        "name",
        "shell",
        "run",
      ]) ||
      selfTest?.properties.get("shell")?.value !== "bash" ||
      selfTest?.properties.get("run")?.value !==
        'scripts/check-rust-clippy.sh --self-test "${{ matrix.target_os }}"'
    ) {
      failures.push(
        `${relativeFile}:${nativeClippy.start + 1}: rust_native_clippy must run exactly one unconditional target-bound negative control`,
      );
    }
    const lints = stepsByName(
      "Lint every Rust crate under wallet/ at -D warnings",
    );
    const lint = lints[0];
    if (
      lints.length !== 1 ||
      !hasExactKeys(lint?.properties ?? new Map(), ["name", "shell", "run"]) ||
      lint?.properties.get("shell")?.value !== "bash" ||
      lint?.properties.get("run")?.value !== "scripts/check-rust-clippy.sh"
    ) {
      failures.push(
        `${relativeFile}:${nativeClippy.start + 1}: rust_native_clippy must run exactly one unconditional all-wallet lint entrypoint`,
      );
    }
  }

  const validatedReusableWorkflows = new Set();
  for (const dependency of parsedNeeds.values) {
    const job = jobs.get(dependency);
    const uses = job?.properties.get("uses");
    if (!uses) continue;
    const reference = requiredJobUsesReference(relativeFile, uses, failures);
    if (!reference) continue;
    if (!/^\.\/\.github\/workflows\/[^/]+\.ya?ml$/.test(reference)) {
      failures.push(
        `${relativeFile}:${uses.index + 1}: required-gate job ${dependency} must call a repository-local reusable workflow`,
      );
      continue;
    }
    const target = localTarget(repoRoot, reference);
    if (target.error) {
      failures.push(`${relativeFile}:${uses.index + 1}: ${target.error}`);
      continue;
    }
    failures.push(
      ...requiredReusableWorkflowFailures(
        repoRoot,
        target.file,
        validatedReusableWorkflows,
      ),
    );
  }

  for (const jobId of [...parsedNeeds.values, "gate"]) {
    const requiredJob = jobs.get(jobId);
    if (requiredJob) {
      failures.push(
        ...requiredJobExecutionFailures(relativeFile, lines, requiredJob),
      );
    }
    const property = requiredJob?.properties.get("continue-on-error");
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
  const changes = jobs.get("changes");
  if (!changes) {
    failures.push(
      `${relativeFile}: required workflow must contain the changes job`,
    );
  } else {
    failures.push(
      ...requiredChangesControlFailures(relativeFile, lines, changes),
    );
    if (enforceNativeClippy) {
      failures.push(
        ...nativeClippySelectorFailures(relativeFile, lines, changes),
      );
    }
  }
  failures.push(...requiredGateControlFailures(relativeFile, lines, gate));

  return failures;
}

function selectorResult(value, name) {
  if (value === "true") return "success";
  if (value === "false") return "skipped";
  throw new Error(
    `invalid or missing ${name} change-detector output: ${value}`,
  );
}

function verifyGateResults(policyOutcome, serializedNeeds) {
  if (policyOutcome !== "success") {
    throw new Error(
      `gate-local policy recheck did not pass: ${policyOutcome || "missing"}`,
    );
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
    throw new Error(
      `change detection did not pass: ${changes.result || "missing"}`,
    );
  }
  if (!changes.outputs || typeof changes.outputs !== "object") {
    throw new Error("change detection outputs are missing");
  }
  const zuuliExpected = selectorResult(changes.outputs.zuuli, "ZUULI");
  const schemaExpected = selectorResult(
    changes.outputs.zuuallet_schema,
    "Zuuallet schema",
  );
  const nativeClippyExpected =
    zuuliExpected === "success" || schemaExpected === "success"
      ? "success"
      : "skipped";

  const verdicts = [];
  for (const [job, state] of entries) {
    if (
      !state ||
      typeof state !== "object" ||
      typeof state.result !== "string"
    ) {
      throw new Error(`required job ${job} has no result`);
    }
    const expected =
      job === "changes"
        ? "success"
        : job === "zuuallet_schema"
          ? schemaExpected
          : job === "rust_native_clippy"
            ? nativeClippyExpected
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
  if (
    relativeCandidate.startsWith("..") ||
    path.isAbsolute(relativeCandidate)
  ) {
    return { error: `local action escapes the repository: ${reference}` };
  }
  if (!fs.existsSync(candidate)) {
    return { error: `local action or workflow does not exist: ${reference}` };
  }
  const canonical = fs.realpathSync(candidate);
  const relativeCanonical = path.relative(repoRoot, canonical);
  if (
    relativeCanonical.startsWith("..") ||
    path.isAbsolute(relativeCanonical)
  ) {
    return {
      error: `local action resolves outside the repository: ${reference}`,
    };
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
    if (relativeFile.split(path.sep).join("/") === REQUIRED_WORKFLOW_PATH) {
      failures.push(...gatePolicyFailures(repoRoot, relativeFile, lines));
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
        failures.push(
          `${location}: invalid external \`uses:\` reference: ${reference}`,
        );
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
  const baseline = gatePolicyFailures(
    repoRoot,
    relative,
    source.split(/\r?\n/),
  );
  if (baseline.length) {
    throw new Error(
      `current required workflow is not a valid mutation base: ${baseline.join("; ")}`,
    );
  }
  const replaceLast = (value, target, replacement) => {
    const index = value.lastIndexOf(target);
    if (index < 0) return value;
    return (
      value.slice(0, index) + replacement + value.slice(index + target.length)
    );
  };

  const checkoutLine = `      - uses: ${GATE_CHECKOUT_REFERENCE} # v7.0.1\n`;
  const policyName =
    "      - name: Recheck immutable actions and fail-closed required jobs";
  const policyBlock = [
    policyName,
    "        id: policy",
    "        run: |",
    `          ${GATE_POLICY_SELF_TEST_COMMAND}`,
    `          ${GATE_POLICY_COMMAND}`,
    "",
  ].join("\n");
  const verdictName =
    "      - name: Verify required jobs succeeded or legitimately skipped";
  const mutations = [
    {
      name: "real workflow rejects native clippy detached from gate",
      needle: "gate must await rust_native_clippy",
      source: source.replace(", rust_native_clippy", ""),
    },
    {
      name: "real workflow rejects a stale native checkout",
      needle: "must match the exact current-source native job contract",
      source: source.replace(
        `      - uses: ${GATE_CHECKOUT_REFERENCE} # v7.0.1\n\n      - name: Fetch librustzcash submodule`,
        `      - uses: ${GATE_CHECKOUT_REFERENCE} # v7.0.1\n        with:\n          ref: 0123456789abcdef0123456789abcdef01234567\n\n      - name: Fetch librustzcash submodule`,
      ),
    },
    {
      name: "real workflow rejects a native source reset step",
      needle: "must match the exact current-source native job contract",
      source: source.replace(
        "      - name: Prove native target selection and -D warnings",
        "      - name: Reset to an earlier clean source\n        run: git checkout 0123456789abcdef0123456789abcdef01234567\n\n      - name: Prove native target selection and -D warnings",
      ),
    },
    {
      name: "real workflow rejects a non-native target matrix",
      needle: "must use the exact macOS/Windows native matrix",
      source: source.replace(
        "            target_os: windows",
        "            target_os: linux",
      ),
    },
    {
      name: "real workflow rejects a weakened native clippy selector",
      needle: "rust_native_clippy if differs from its required value",
      source: source.replace(
        "    if: needs.changes.outputs.zuuli == 'true' || needs.changes.outputs.zuuallet_schema == 'true'",
        "    if: needs.changes.outputs.zuuli == 'true'",
      ),
    },
    {
      name: "real workflow selects root Cargo workspace inputs for native clippy",
      needle:
        "native clippy input must select at least one native lint path: Cargo.toml",
      source: source.replaceAll("Cargo.toml|Cargo.lock|", ""),
    },
    {
      name: "real workflow selects root Cargo configuration for native clippy",
      needle:
        "native clippy input must select at least one native lint path: .cargo/config.toml",
      source: source.replaceAll(".cargo/*|", ""),
    },
    {
      name: "real workflow selects root Clippy configuration for native clippy",
      needle:
        "native clippy input must select at least one native lint path: clippy.toml",
      source: source.replaceAll("clippy.toml|.clippy.toml|", ""),
    },
    {
      name: "real workflow selects wallet parent workspace manifests for native clippy",
      needle:
        "native clippy input must select at least one native lint path: wallet/Cargo.toml",
      source: source.replaceAll("wallet/Cargo.toml|wallet/Cargo.lock|", ""),
    },
    {
      name: "real workflow selects wallet parent lint configuration for native clippy",
      needle:
        "native clippy input must select at least one native lint path: wallet/.cargo/config.toml",
      source: source.replaceAll(
        "wallet/.cargo/*|wallet/clippy.toml|wallet/.clippy.toml|",
        "",
      ),
    },
    {
      name: "real workflow selects future wallet Rust sources for native clippy",
      needle:
        "native clippy input must select at least one native lint path: wallet/future-crate/src/lib.rs",
      source: source.replaceAll("wallet/*.rs|", ""),
    },
    {
      name: "real workflow selects future wallet manifests for native clippy",
      needle:
        "native clippy input must select at least one native lint path: wallet/future-crate/Cargo.toml",
      source: source.replaceAll("wallet/*/Cargo.toml|wallet/*/Cargo.lock|", ""),
    },
    {
      name: "real workflow selects future wallet Cargo configuration for native clippy",
      needle:
        "native clippy input must select at least one native lint path: wallet/future-crate/.cargo/config.toml",
      source: source.replaceAll("wallet/*/.cargo/*|", ""),
    },
    {
      name: "real workflow selects future wallet Clippy configuration for native clippy",
      needle:
        "native clippy input must select at least one native lint path: wallet/future-crate/clippy.toml",
      source: source.replaceAll(
        "wallet/*/clippy.toml|wallet/*/.clippy.toml|",
        "",
      ),
    },
    {
      name: "real workflow rejects a decorative native negative control",
      needle:
        "must run exactly one unconditional target-bound negative control",
      source: source.replace(
        '        run: scripts/check-rust-clippy.sh --self-test "${{ matrix.target_os }}"',
        '        run: echo "native clippy self-test"',
      ),
    },
    {
      name: "real workflow rejects a skipped native negative control",
      needle:
        "must run exactly one unconditional target-bound negative control",
      source: source.replace(
        '        run: scripts/check-rust-clippy.sh --self-test "${{ matrix.target_os }}"',
        '        run: scripts/check-rust-clippy.sh --self-test "${{ matrix.target_os }}"\n        if: false',
      ),
    },
    {
      name: "real workflow rejects a decorative native lint verdict",
      needle: "must run exactly one unconditional all-wallet lint entrypoint",
      source: source.replace(
        "      - name: Lint every Rust crate under wallet/ at -D warnings\n        shell: bash\n        run: scripts/check-rust-clippy.sh",
        "      - name: Lint every Rust crate under wallet/ at -D warnings\n        shell: bash\n        run: echo clean",
      ),
    },
    {
      name: "real workflow rejects a skipped native lint verdict",
      needle: "must run exactly one unconditional all-wallet lint entrypoint",
      source: source.replace(
        "      - name: Lint every Rust crate under wallet/ at -D warnings\n        shell: bash\n        run: scripts/check-rust-clippy.sh",
        "      - name: Lint every Rust crate under wallet/ at -D warnings\n        shell: bash\n        run: scripts/check-rust-clippy.sh\n        if: false",
      ),
    },
    {
      name: "real workflow rejects log-only needs consumption",
      needle:
        "must unconditionally recheck policy and enforce the complete needs context",
      source: source.replace(
        `          ${GATE_VERDICT_COMMAND}\n`,
        '          echo "$REQUIRED_JOBS_JSON"\n',
      ),
    },
    {
      name: "real workflow rejects a dynamically dead verdict",
      needle:
        "must unconditionally recheck policy and enforce the complete needs context",
      source: source.replace(
        verdictName,
        `${verdictName}\n        if: github.event_name == '__never__'`,
      ),
    },
    {
      name: "real workflow rejects deleted gate checkout",
      needle:
        "must contain exactly checkout, policy recheck, and enforcing verdict steps",
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
      needle:
        "must contain exactly checkout, policy recheck, and enforcing verdict steps",
      source: source.replace(policyBlock, ""),
    },
    {
      name: "real workflow rejects dynamically dead policy recheck",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      source: source.replace(
        policyName,
        `${policyName}\n        if: github.event_name == '__never__'`,
      ),
    },
    {
      name: "real workflow rejects soft-failing policy recheck",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      source: source.replace(
        policyName,
        `${policyName}\n        continue-on-error: true`,
      ),
    },
    {
      name: "real workflow rejects a missing gate policy self-test",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      source: replaceLast(
        source,
        `          ${GATE_POLICY_SELF_TEST_COMMAND}\n`,
        "",
      ),
    },
    {
      name: "real workflow rejects a replaced changes policy invocation",
      needle:
        "changes policy step must exactly self-test and enforce the current-source policy",
      source: source.replace(
        [
          "      - name: Verify immutable actions and fail-closed required jobs",
          "        run: |",
          `          ${GATE_POLICY_SELF_TEST_COMMAND}`,
          `          ${GATE_POLICY_COMMAND}`,
        ].join("\n"),
        [
          "      - name: Verify immutable actions and fail-closed required jobs",
          "        run: true",
        ].join("\n"),
      ),
    },
    {
      name: "real workflow rejects a dynamically dead changes policy",
      needle:
        "changes policy step must exactly self-test and enforce the current-source policy",
      source: source.replace(
        "      - name: Verify immutable actions and fail-closed required jobs",
        "      - name: Verify immutable actions and fail-closed required jobs\n        if: false",
      ),
    },
    {
      name: "real workflow rejects a soft-failing changes policy",
      needle:
        "changes policy step must exactly self-test and enforce the current-source policy",
      source: source.replace(
        "      - name: Verify immutable actions and fail-closed required jobs",
        "      - name: Verify immutable actions and fail-closed required jobs\n        continue-on-error: true",
      ),
    },
    {
      name: "real workflow rejects a soft-failing required gate",
      needle:
        "job-level continue-on-error is forbidden on required-gate job gate",
      source: source.replace(
        "  gate:\n",
        "  gate:\n    continue-on-error: true\n",
      ),
    },
    {
      name: "real workflow rejects a syntax-only gate default shell",
      needle: "required job gate defaults.run.shell must be exactly bash",
      source: source.replace(
        "    timeout-minutes: 5\n    steps:\n      # Re-run the workflow policy here",
        [
          "    timeout-minutes: 5",
          "    defaults:",
          "      run:",
          "        shell: bash -n {0}",
          "    steps:",
          "      # Re-run the workflow policy here",
        ].join("\n"),
      ),
    },
    {
      name: "real workflow rejects a syntax-only workflow default shell",
      needle: "required workflow defaults.run.shell must be exactly bash",
      source: source.replace(
        "permissions:\n  contents: read",
        [
          "defaults:",
          "  run:",
          "    shell: sh -n {0}",
          "",
          "permissions:",
          "  contents: read",
        ].join("\n"),
      ),
    },
    {
      name: "real workflow rejects a syntax-only required step shell",
      needle: "required job changes step shell must be exactly bash",
      source: source.replace(
        "        shell: bash\n",
        "        shell: bash -n {0}\n",
      ),
    },
    {
      name: "real workflow rejects workflow-level SHELLOPTS noexec",
      needle:
        "required workflow environment differs from its exact reviewed allowlist",
      source: source.replace(
        "env:\n  CARGO_TERM_COLOR: always\n",
        "env:\n  SHELLOPTS: noexec\n  CARGO_TERM_COLOR: always\n",
      ),
    },
    {
      name: "real workflow rejects gate-level NODE_OPTIONS startup injection",
      needle:
        "required job gate environment differs from its exact reviewed allowlist",
      source: source.replace(
        "  gate:\n",
        '  gate:\n    env:\n      NODE_OPTIONS: "--import=data:text/javascript,process.exit(0)"\n',
      ),
    },
    {
      name: "real workflow rejects gate-step imported node function",
      needle:
        "required job gate step Verify required jobs succeeded or legitimately skipped environment differs from its exact reviewed allowlist",
      source: source.replace(
        "        env:\n          POLICY_OUTCOME: ${{ steps.policy.outcome }}\n",
        "        env:\n          'BASH_FUNC_node%%': '() { return 0; }'\n          POLICY_OUTCOME: ${{ steps.policy.outcome }}\n",
      ),
    },
    {
      name: "real workflow rejects PATH injection on a required step",
      needle:
        "required job changes step Detect release-impacting ZUULI changes environment differs from its exact reviewed allowlist",
      source: source.replace(
        "        env:\n          BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before }}\n",
        "        env:\n          BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before }}\n          PATH: ./ci-shims\n",
      ),
    },
    {
      name: "real workflow requires its reviewed environment",
      needle:
        "required workflow environment differs from its exact reviewed allowlist",
      source: source.replace(
        "env:\n  CARGO_TERM_COLOR: always\n  RUST_BACKTRACE: 1\n\n",
        "",
      ),
    },
    {
      name: "real workflow requires the schema job environment",
      needle:
        "required job zuuallet_schema environment differs from its exact reviewed allowlist",
      source: source.replace(
        "    env:\n      CARGO_TARGET_DIR: ${{ github.workspace }}/target\n",
        "",
      ),
    },
    {
      name: "real workflow requires the ZUULI build nonce environment",
      needle:
        "required job rust_app step Build ZUULI Tauri backend environment differs from its exact reviewed allowlist",
      source: source.replace(
        [
          "        env:",
          "          # The build script watches this value. Changing it on every attempt",
          "          # forces schema generation even when Cargo artifacts were restored.",
          "          TAURI_SCHEMA_GENERATION_NONCE: ${{ github.run_id }}-${{ github.run_attempt }}",
          "          TAURI_PERMISSION_GENERATION_NONCE: ${{ github.run_id }}-${{ github.run_attempt }}",
        ].join("\n") + "\n",
        "",
      ),
    },
    {
      name: "real workflow requires the Zuuallet schema nonce environment",
      needle:
        "required job zuuallet_schema step Regenerate Zuuallet permissions and target schema environment differs from its exact reviewed allowlist",
      source: source.replace(
        [
          "        env:",
          "          # These values are build-script inputs, so restored Cargo artifacts",
          "          # cannot turn this freshness assertion into a no-op.",
          "          TAURI_SCHEMA_GENERATION_NONCE: ${{ github.run_id }}-${{ github.run_attempt }}",
          "          TAURI_PERMISSION_GENERATION_NONCE: ${{ github.run_id }}-${{ github.run_attempt }}",
        ].join("\n") + "\n",
        "",
      ),
    },
    {
      name: "real workflow requires the change-detector environment",
      needle:
        "required job changes step Detect release-impacting ZUULI changes environment differs from its exact reviewed allowlist",
      source: source.replace(
        "        env:\n          BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before }}\n",
        "",
      ),
    },
    {
      name: "real workflow requires the gate verdict environment",
      needle:
        "required job gate step Verify required jobs succeeded or legitimately skipped environment differs from its exact reviewed allowlist",
      source: source.replace(
        "        env:\n          POLICY_OUTCOME: ${{ steps.policy.outcome }}\n          REQUIRED_JOBS_JSON: ${{ toJSON(needs) }}\n",
        "",
      ),
    },
    {
      name: "real workflow rejects Android job-level SHELLOPTS noexec",
      needle:
        "required job rust_android_32 environment differs from its exact reviewed allowlist",
      source: source.replace(
        "  rust_android_32:\n",
        "  rust_android_32:\n    env:\n      SHELLOPTS: noexec\n",
      ),
    },
    {
      name: "real workflow rejects Android typecheck-step SHELLOPTS noexec",
      needle:
        "required job rust_android_32 step Type-check the shared plugin on 32-bit Android environment differs from its exact reviewed allowlist",
      source: source.replace(
        "      - name: Type-check the shared plugin on 32-bit Android\n        run: |\n",
        "      - name: Type-check the shared plugin on 32-bit Android\n        env:\n          SHELLOPTS: noexec\n        run: |\n",
      ),
    },
    {
      name: "real workflow rejects required-container environment options",
      needle:
        "required job rust_clippy container cannot inject environment or runtime options",
      source: source.replace(
        "      image: ghcr.io/free2z/zuuli-linux-ci@sha256:1f51900724b8ccac86832dbf573a019fdd405f3ad4a407382047e2e4087055a1\n      credentials:\n",
        "      image: ghcr.io/free2z/zuuli-linux-ci@sha256:1f51900724b8ccac86832dbf573a019fdd405f3ad4a407382047e2e4087055a1\n      options: --env SHELLOPTS=noexec\n      credentials:\n",
      ),
    },
    {
      name: "real workflow rejects redirected Rust plugin tests",
      needle:
        "required job rust_plugin step Build and test shared Zcash plugin working-directory differs from its exact reviewed value",
      source: source.replace(
        "      - name: Build and test shared Zcash plugin\n        run: cargo test --locked --all-targets --manifest-path wallet/plugins/tauri-plugin-zcash/Cargo.toml\n",
        "      - name: Build and test shared Zcash plugin\n        working-directory: bypass\n        run: cargo test --locked --all-targets --manifest-path wallet/plugins/tauri-plugin-zcash/Cargo.toml\n",
      ),
    },
    {
      name: "real workflow rejects a changes-job default working directory",
      needle:
        "required job changes defaults.run.working-directory differs from its exact reviewed value",
      source: source.replace(
        "    timeout-minutes: 5\n    outputs:\n",
        "    timeout-minutes: 5\n    defaults:\n      run:\n        working-directory: bypass\n    outputs:\n",
      ),
    },
    {
      name: "real workflow rejects a redirected changes policy step",
      needle:
        "required job changes step Verify immutable actions and fail-closed required jobs working-directory differs from its exact reviewed value",
      source: source.replace(
        "      - name: Verify immutable actions and fail-closed required jobs\n        run: |\n",
        "      - name: Verify immutable actions and fail-closed required jobs\n        working-directory: bypass\n        run: |\n",
      ),
    },
    {
      name: "real workflow rejects a gate-job default working directory",
      needle:
        "required job gate defaults.run.working-directory differs from its exact reviewed value",
      source: source.replace(
        "    timeout-minutes: 5\n    steps:\n      # Re-run the workflow policy here",
        "    timeout-minutes: 5\n    defaults:\n      run:\n        working-directory: bypass\n    steps:\n      # Re-run the workflow policy here",
      ),
    },
    {
      name: "real workflow rejects a redirected gate policy step",
      needle:
        "required job gate step Recheck immutable actions and fail-closed required jobs working-directory differs from its exact reviewed value",
      source: source.replace(
        "      - name: Recheck immutable actions and fail-closed required jobs\n        id: policy\n",
        "      - name: Recheck immutable actions and fail-closed required jobs\n        id: policy\n        working-directory: bypass\n",
      ),
    },
    {
      name: "real workflow rejects an Android-job default working directory",
      needle:
        "required job rust_android_32 defaults.run.working-directory differs from its exact reviewed value",
      source: source.replace(
        "  rust_android_32:\n    name: Rust / Android 32-bit\n",
        "  rust_android_32:\n    name: Rust / Android 32-bit\n    defaults:\n      run:\n        working-directory: bypass\n",
      ),
    },
    {
      name: "real workflow rejects a redirected Android policy-control step",
      needle:
        "required job changes step Verify the required 32-bit Android type-check policy working-directory differs from its exact reviewed value",
      source: source.replace(
        "      - name: Verify the required 32-bit Android type-check policy\n        run: |\n",
        "      - name: Verify the required 32-bit Android type-check policy\n        working-directory: bypass\n        run: |\n",
      ),
    },
    {
      name: "real workflow rejects a redirected Android typecheck step",
      needle:
        "required job rust_android_32 step Type-check the shared plugin on 32-bit Android working-directory differs from its exact reviewed value",
      source: source.replace(
        "      - name: Type-check the shared plugin on 32-bit Android\n        run: |\n",
        "      - name: Type-check the shared plugin on 32-bit Android\n        working-directory: bypass\n        run: |\n",
      ),
    },
    {
      name: "real workflow rejects a workflow default working directory",
      needle:
        "required workflow defaults.run.working-directory differs from its exact reviewed value",
      source: source.replace(
        "permissions:\n  contents: read",
        "defaults:\n  run:\n    working-directory: bypass\n\npermissions:\n  contents: read",
      ),
    },
    {
      name: "real workflow requires the reviewed frontend default working directory",
      needle:
        "required job frontend defaults.run.working-directory differs from its exact reviewed value",
      source: source.replace("        working-directory: wallet/zuuli\n", ""),
    },
    {
      name: "real workflow requires reviewed image-verification working directories",
      needle:
        "required job rust_clippy step Verify pinned Linux build image working-directory differs from its exact reviewed value",
      source: source.replace(
        "      - name: Verify pinned Linux build image\n        working-directory: /\n",
        "      - name: Verify pinned Linux build image\n",
      ),
    },
    {
      name: "real workflow rejects a syntax-only dependency default shell",
      needle:
        "required job zuuallet_schema defaults.run.shell must be exactly bash",
      source: replaceLast(
        source,
        "        shell: bash\n",
        "        shell: bash -n {0}\n",
      ),
    },
    {
      name: "real workflow rejects soft-failing required dependency",
      needle:
        "job-level continue-on-error is forbidden on required-gate job rust_app",
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
    const failures = gatePolicyFailures(
      repoRoot,
      relative,
      mutation.source.split(/\r?\n/),
    );
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
    "        run: |",
    `          ${GATE_POLICY_SELF_TEST_COMMAND}`,
    `          ${GATE_POLICY_COMMAND}`,
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
    "env:",
    "  CARGO_TERM_COLOR: always",
    "  RUST_BACKTRACE: 1",
    "jobs:",
    "  changes:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Verify immutable actions and fail-closed required jobs",
    "        run: |",
    `          ${GATE_POLICY_SELF_TEST_COMMAND}`,
    `          ${GATE_POLICY_COMMAND}`,
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
    "    needs: [changes, build]",
    "    if: always()",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...gateCheckoutLines,
    ...gatePolicyLines,
    ...gateVerdictLines,
    "",
  ].join("\n");
  const reusableBuildJob = [
    "  build:",
    "    uses: ./.github/workflows/required-build.yml",
  ].join("\n");
  const reusableGateWorkflow = validGateWorkflow.replace(
    [
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: a legitimate best-effort step",
      "        continue-on-error: true",
      "        run: echo 'step-level continue-on-error: true is allowed'",
    ].join("\n"),
    reusableBuildJob,
  );
  const reusableBuildWorkflow = [
    "name: required reusable build",
    "on:",
    "  workflow_call:",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: npm test",
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
      name: "valid required gate may call a local reusable workflow without environment blocks",
      valid: true,
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow,
      },
    },
    {
      name: "required reusable workflow rejects workflow-level BASH_ENV",
      needle:
        "required workflow environment differs from its exact reviewed allowlist",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "jobs:\n",
          "env:\n  BASH_ENV: bypass-gate.sh\njobs:\n",
        ),
      },
    },
    {
      name: "required reusable workflow rejects job-level SHELLOPTS",
      needle:
        "required job build environment differs from its exact reviewed allowlist",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "  build:\n",
          "  build:\n    env:\n      SHELLOPTS: noexec\n",
        ),
      },
    },
    {
      name: "required reusable workflow rejects step-level PATH replacement",
      needle:
        "required job build step <unnamed> environment differs from its exact reviewed allowlist",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "      - run: npm test\n",
          "      - env:\n          PATH: ./ci-shims\n        run: npm test\n",
        ),
      },
    },
    {
      name: "nested required reusable workflow rejects NODE_OPTIONS",
      needle:
        "required job nested environment differs from its exact reviewed allowlist",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "    runs-on: ubuntu-latest\n    steps:\n      - run: npm test",
          "    uses: ./.github/workflows/nested-build.yml",
        ),
        ".github/workflows/nested-build.yml": [
          "on:",
          "  workflow_call:",
          "jobs:",
          "  nested:",
          "    env:",
          '      NODE_OPTIONS: "--import=data:text/javascript,process.exit(0)"',
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: cargo test",
          "",
        ].join("\n"),
      },
    },
    {
      name: "quoted BASH_FUNC key cannot hide required-job environment injection",
      needle:
        "required job build environment differs from its exact reviewed allowlist",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n    env:\n      'BASH_FUNC_node%%': '() { return 0; }'\n",
        ),
      ),
    },
    {
      name: "inline required-job environment maps fail closed",
      needle:
        "required job build environment must use a canonical block mapping",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n    env: { SHELLOPTS: noexec }\n",
        ),
      ),
    },
    {
      name: "required-step environment merge aliases fail closed",
      needle: "cannot use YAML merge keys or aliases",
      files: gateFixture(
        validGateWorkflow.replace(
          "      - name: a legitimate best-effort step\n",
          "      - name: a legitimate best-effort step\n        env:\n          <<: *execution-environment\n",
        ),
      ),
    },
    {
      name: "required reusable workflow rejects a default working directory",
      needle:
        "required job build defaults.run.working-directory differs from its exact reviewed value",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "    runs-on: ubuntu-latest\n",
          "    runs-on: ubuntu-latest\n    defaults:\n      run:\n        working-directory: bypass\n",
        ),
      },
    },
    {
      name: "required reusable workflow rejects a step working directory",
      needle:
        "required job build step <unnamed> working-directory differs from its exact reviewed value",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "      - run: npm test\n",
          "      - working-directory: bypass\n        run: npm test\n",
        ),
      },
    },
    {
      name: "quoted working-directory keys remain policy-visible",
      needle:
        "required job build step a legitimate best-effort step working-directory differs from its exact reviewed value",
      files: gateFixture(
        validGateWorkflow.replace(
          "      - name: a legitimate best-effort step\n",
          "      - name: a legitimate best-effort step\n        'working-directory': bypass\n",
        ),
      ),
    },
    {
      name: "inline required-job defaults fail closed",
      needle: "required job build defaults must use a canonical block mapping",
      files: gateFixture(
        validGateWorkflow.replace(
          "    runs-on: ubuntu-latest\n    steps:\n      - name: a legitimate best-effort step\n",
          "    runs-on: ubuntu-latest\n    defaults: { run: { working-directory: bypass } }\n    steps:\n      - name: a legitimate best-effort step\n",
        ),
      ),
    },
    {
      name: "required-job default working-directory merge aliases fail closed",
      needle: "defaults.run contains an unsupported or duplicate property",
      files: gateFixture(
        validGateWorkflow.replace(
          "    runs-on: ubuntu-latest\n    steps:\n      - name: a legitimate best-effort step\n",
          "    runs-on: ubuntu-latest\n    defaults:\n      run:\n        <<: *redirected-defaults\n    steps:\n      - name: a legitimate best-effort step\n",
        ),
      ),
    },
    {
      name: "required reusable workflow cannot inherit a syntax-only shell",
      needle: "required job build defaults.run.shell must be exactly bash",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "    runs-on: ubuntu-latest\n",
          [
            "    runs-on: ubuntu-latest",
            "    defaults:",
            "      run:",
            "        shell: bash -n {0}",
            "",
          ].join("\n"),
        ),
      },
    },
    {
      name: "required workflow cannot select a dynamic default shell",
      needle: "required workflow defaults.run.shell must be exactly bash",
      files: gateFixture(
        validGateWorkflow.replace(
          "on: pull_request\n",
          [
            "on: pull_request",
            "defaults:",
            "  run:",
            "    shell: ${{ inputs.shell }}",
            "",
          ].join("\n"),
        ),
      ),
    },
    {
      name: "required dependency cannot override a step with a non-bash shell",
      needle: "required job build step shell must be exactly bash",
      files: gateFixture(
        validGateWorkflow.replace(
          "      - name: a legitimate best-effort step\n",
          "      - name: a legitimate best-effort step\n        shell: python {0}\n",
        ),
      ),
    },
    {
      name: "reindented required steps cannot hide a shell override",
      needle:
        "required job build steps must begin with a canonical block-sequence entry",
      files: gateFixture(
        validGateWorkflow.replace(
          [
            "    steps:",
            "      - name: a legitimate best-effort step",
            "        continue-on-error: true",
            "        run: echo 'step-level continue-on-error: true is allowed'",
          ].join("\n"),
          [
            "    steps:",
            "        - name: a legitimate best-effort step",
            "          shell: bash -n {0}",
            "          run: echo hidden",
          ].join("\n"),
        ),
      ),
    },
    {
      name: "required reusable workflow cannot soft-fail an internal job",
      needle:
        "job-level continue-on-error is forbidden in required reusable workflow job build",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "  build:\n",
          "  build:\n    continue-on-error: true\n",
        ),
      },
    },
    {
      name: "nested required reusable workflow cannot hide a soft-failing job",
      needle:
        "job-level continue-on-error is forbidden in required reusable workflow job nested",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "    runs-on: ubuntu-latest\n    steps:\n      - run: npm test",
          "    uses: ./.github/workflows/nested-build.yml",
        ),
        ".github/workflows/nested-build.yml": [
          "on:",
          "  workflow_call:",
          "jobs:",
          "  nested:",
          "    continue-on-error: true",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: cargo test",
          "",
        ].join("\n"),
      },
    },
    {
      name: "external reusable workflow is forbidden as a gate dependency",
      needle:
        "required-gate job build must call a repository-local reusable workflow",
      files: gateFixture(
        reusableGateWorkflow.replace(
          "./.github/workflows/required-build.yml",
          `owner/repo/.github/workflows/build.yml@${fullSha} # reviewed`,
        ),
      ),
    },
    {
      name: "external reusable workflow is forbidden behind a local callee",
      needle:
        "required reusable workflow job build must call a repository-local workflow",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "    runs-on: ubuntu-latest\n    steps:\n      - run: npm test",
          `    uses: owner/repo/.github/workflows/build.yml@${fullSha} # reviewed`,
        ),
      },
    },
    {
      name: "non-required workflows may use valid noncanonical indentation",
      valid: true,
      files: {
        ".github/workflows/formatted.yml": [
          "name: formatter output",
          "on: pull_request",
          "jobs:",
          "   formatted:",
          "      runs-on: ubuntu-latest",
          "      steps:",
          "      - run: true",
          "",
        ].join("\n"),
      },
    },
    {
      name: "tab-indented required control fails closed",
      needle: "tabs are unsupported in YAML indentation",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n\tcontinue-on-error: true\n",
        ),
      ),
    },
    {
      name: "changes policy invocation cannot be replaced",
      needle:
        "changes policy step must exactly self-test and enforce the current-source policy",
      files: gateFixture(
        validGateWorkflow.replace(
          `        run: |\n          ${GATE_POLICY_SELF_TEST_COMMAND}\n          ${GATE_POLICY_COMMAND}\n`,
          "        run: true\n",
        ),
      ),
    },
    {
      name: "gate dependency cannot use job-level continue-on-error",
      needle:
        "job-level continue-on-error is forbidden on required-gate job build",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n    continue-on-error: true\n",
        ),
      ),
    },
    {
      name: "false job-level continue-on-error is still forbidden",
      needle:
        "job-level continue-on-error is forbidden on required-gate job build",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n    continue-on-error: false\n",
        ),
      ),
    },
    {
      name: "escaped quoted key cannot hide job-level continue-on-error",
      needle:
        "job-level continue-on-error is forbidden on required-gate job build",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          '  build:\n    "continue-\\u006fn-error": true\n',
        ),
      ),
    },
    {
      name: "single-quoted key cannot hide job-level continue-on-error",
      needle:
        "job-level continue-on-error is forbidden on required-gate job build",
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
      needle:
        "job-level continue-on-error is forbidden on required-gate job gate",
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
          "    needs: [changes, build]\n",
          "    needs:\n      - changes\n      - build\n",
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
            "    needs: [changes, build]\n",
            "    needs: [changes, build, rust_android_32]\n",
          ),
      ),
    },
    {
      name: "logging the needs context cannot replace the enforcing verdict",
      needle:
        "must unconditionally recheck policy and enforce the complete needs context",
      files: gateFixture(
        validGateWorkflow.replace(
          `          ${GATE_VERDICT_COMMAND}\n`,
          '          echo "$REQUIRED_JOBS_JSON"\n',
        ),
      ),
    },
    {
      name: "dynamically dead verdict use fails closed",
      needle:
        "must unconditionally recheck policy and enforce the complete needs context",
      files: gateFixture(
        validGateWorkflow.replace(
          gateVerdictLines[0],
          `${gateVerdictLines[0]}\n        if: github.event_name == '__never__'`,
        ),
      ),
    },
    {
      name: "deleted gate checkout fails closed",
      needle:
        "must contain exactly checkout, policy recheck, and enforcing verdict steps",
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
      needle:
        "must contain exactly checkout, policy recheck, and enforcing verdict steps",
      files: gateFixture(
        validGateWorkflow.replace(`${gatePolicyLines.join("\n")}\n`, ""),
      ),
    },
    {
      name: "dynamically dead gate policy recheck fails closed",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      files: gateFixture(
        validGateWorkflow.replace(
          gatePolicyLines[0],
          `${gatePolicyLines[0]}\n        if: github.event_name == '__never__'`,
        ),
      ),
    },
    {
      name: "soft-failing gate policy recheck fails closed",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
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
      files: {
        ".github/workflows/gate.yml": "steps:\n  - uses: owner/action@v1\n",
      },
    },
    {
      name: "branch",
      needle: "owner/action@main",
      files: {
        ".github/workflows/gate.yml": "steps:\n  - uses: owner/action@main\n",
      },
    },
    {
      name: "short SHA",
      needle: "owner/action@0123456",
      files: {
        ".github/workflows/gate.yml":
          "steps:\n  - uses: owner/action@0123456\n",
      },
    },
    {
      name: "commit pin without readable provenance",
      needle: "version/provenance comment",
      files: {
        ".github/workflows/gate.yml": `steps:\n  - uses: owner/action@${fullSha}\n`,
      },
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
      files: {
        ".github/workflows/gate.yml":
          'steps:\n  - uses: "owner/action@v2" # mutable\n',
      },
    },
    {
      name: "quoted uses key cannot hide a mutable reference",
      needle: "owner/action@v4",
      files: {
        ".github/workflows/gate.yml":
          "steps:\n  - \"uses\": owner/action@v4\n  - 'uses': owner/other@main\n",
      },
    },
    {
      name: "escaped quoted uses key cannot hide a mutable reference",
      needle: "owner/action@main",
      files: {
        ".github/workflows/gate.yml":
          'steps:\n  - "\\u0075ses": owner/action@main\n',
      },
    },
    {
      name: "nested local action is scanned",
      needle: "owner/nested@nightly",
      files: {
        ".github/workflows/gate.yml":
          "steps:\n  - uses: ./.github/actions/nested\n",
        ".github/actions/nested/action.yml":
          "runs:\n  using: composite\n  steps:\n    - uses: owner/nested@nightly\n",
      },
    },
    {
      name: "missing local action fails closed",
      needle: "does not exist",
      files: {
        ".github/workflows/gate.yml":
          "steps:\n  - uses: ./.github/actions/missing\n",
      },
    },
    {
      name: "expression reference fails closed",
      needle: "invalid external",
      files: {
        ".github/workflows/gate.yml":
          "steps:\n  - uses: owner/action@${{ inputs.ref }}\n",
      },
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
        ".github/workflows/gate.yml":
          'steps: [{ "\\u0075ses": owner/action@v2 }]\n',
      },
    },
    {
      name: "explicit mapping key cannot hide a mutable reference",
      needle: "explicit YAML mapping keys",
      files: {
        ".github/workflows/gate.yml":
          "steps:\n  - ? uses\n    : owner/action@v3\n",
      },
    },
    {
      name: "anchored step cannot hide a mutable reference",
      needle: "decorated, inline, or explicit",
      files: {
        ".github/workflows/gate.yml":
          "steps:\n  - &shared uses: owner/action@main\n",
      },
    },
    {
      name: "tagged step cannot hide a mutable reference",
      needle: "decorated, inline, or explicit",
      files: {
        ".github/workflows/gate.yml":
          "steps:\n  - !!str uses: owner/action@main\n",
      },
    },
    {
      name: "explicit anchored key cannot hide a mutable reference",
      needle: "explicit YAML mapping keys",
      files: {
        ".github/workflows/gate.yml":
          "steps:\n  - ? &action-key uses\n    : owner/action@v3\n",
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
        ".github/workflows/gate.yml":
          'steps: [{ "u\\x73es": owner/action@main }]\n',
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

  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "zuu-action-pins-"),
  );
  try {
    for (const testCase of cases) {
      const fixture = path.join(
        temporaryRoot,
        testCase.name.replaceAll(/[^a-z0-9]+/gi, "-"),
      );
      for (const [relative, contents] of Object.entries(testCase.files)) {
        writeFixture(fixture, relative, contents);
      }
      const result = scanRepository(fixture);
      if (testCase.valid) {
        if (result.failures.length) {
          throw new Error(
            `${testCase.name}: expected success, got ${result.failures.join("; ")}`,
          );
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
        rust_native_clippy: { result: "success", outputs: {} },
        zuuallet_schema: { result: "success", outputs: {} },
      },
    },
    {
      name: "native clippy cannot skip a Zuuallet-only Rust change",
      policyOutcome: "success",
      needle: "required job rust_native_clippy must be success, got skipped",
      needs: {
        changes: {
          result: "success",
          outputs: { zuuli: "false", zuuallet_schema: "true" },
        },
        rust_native_clippy: { result: "skipped", outputs: {} },
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
      throw new Error(
        `${testCase.name}: expected success, got ${error.message}`,
      );
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
  (args.length === 1 &&
    !["--self-test", "--verify-gate-results"].includes(mode))
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
      `and every required-gate dependency is bound to the enforcing verdict (${result.externalReferences} ` +
      `external reference(s), ${result.scannedFiles} file(s)).`,
  );
}
