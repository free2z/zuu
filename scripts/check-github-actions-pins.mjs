#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
const EXTERNAL_USES = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@([^@\s]+)$/;

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
  console.log(`self-test: ${cases.length} action pin policy case(s) passed.`);
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
    console.error("GitHub Actions immutable-reference policy failed:");
    for (const failure of result.failures) console.error(`- ${failure}`);
    console.error(
      `${result.failures.length} failure(s); scanned ${result.scannedFiles} workflow/action file(s) and ${result.externalReferences} external reference(s).`,
    );
    process.exit(1);
  }
  console.log(
    `Every external GitHub Action and reusable workflow is pinned to a full 40-character commit SHA with readable provenance (${result.externalReferences} reference(s), ${result.scannedFiles} file(s)).`,
  );
}
