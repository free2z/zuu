#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = Object.freeze({
  dockerfile: ".github/containers/zuuli-store-capture/Dockerfile",
  verifier: ".github/containers/zuuli-store-capture/verify-inventory.sh",
  workflow: ".github/workflows/zuuli-store-capture-image.yml",
  gate: ".github/workflows/zuuli.yml",
});

const rustImage =
  "rust:1.97.1-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3";
const playwrightImage =
  "mcr.microsoft.com/playwright@sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac";
const imageRepository = "ghcr.io/free2z/zuuli-store-capture";
const allowedActions = new Set([
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "docker/setup-buildx-action@37fe631027851001ddb9b187196cc803df7f5f0e",
  "docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a",
  "docker/login-action@dbcb813823bdd20940b903addbd779551569679f",
  "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
]);

function readTree(root = repoRoot) {
  return Object.fromEntries(
    Object.entries(paths).map(([name, path]) => [
      name,
      readFileSync(resolve(root, path), "utf8"),
    ]),
  );
}

function count(source, needle) {
  return source.split(needle).length - 1;
}

function requireExactly(failures, source, needle, expected, diagnostic) {
  const actual = count(source, needle);
  if (actual !== expected) failures.push(`${diagnostic}; expected ${expected}, found ${actual}`);
}

function requireExactBlock(failures, source, block, expected, diagnostic) {
  let actual = 0;
  let cursor = 0;
  while (cursor <= source.length) {
    const start = source.indexOf(block, cursor);
    if (start < 0) break;
    const end = start + block.length;
    if (
      (start === 0 || source[start - 1] === "\n") &&
      (end === source.length || source[end] === "\n")
    ) {
      actual += 1;
    }
    cursor = start + 1;
  }
  if (actual !== expected) failures.push(`${diagnostic}; expected ${expected}, found ${actual}`);
}

function jobBlock(workflow, name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) return "";
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/^  [a-zA-Z0-9_-]+:\s*$/m);
  return next < 0 ? rest : rest.slice(0, next);
}

export function validateStoreCaptureImage(documents) {
  const failures = [];
  const { dockerfile, verifier, workflow, gate } = documents;

  requireExactBlock(
    failures,
    dockerfile,
    `FROM ${rustImage} AS rust-toolchain`,
    1,
    "Dockerfile must use the reviewed exact Rust image",
  );
  requireExactBlock(
    failures,
    dockerfile,
    `FROM ${playwrightImage}`,
    1,
    "Dockerfile must use the reviewed exact Playwright image",
  );
  requireExactBlock(
    failures,
    dockerfile,
    "RUN rustup target add --toolchain 1.97.1 wasm32-unknown-unknown",
    1,
    "Dockerfile must install the exact WASM target",
  );
  for (const copy of [
    "COPY --from=rust-toolchain /usr/local/cargo /usr/local/cargo",
    "COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup",
  ]) {
    requireExactBlock(failures, dockerfile, copy, 1, `Dockerfile missing toolchain copy: ${copy}`);
  }
  for (const environment of [
    "ENV CARGO_HOME=/usr/local/cargo",
    "ENV RUSTUP_HOME=/usr/local/rustup",
    "ENV PATH=/usr/local/cargo/bin:${PATH}",
  ]) {
    requireExactBlock(failures, dockerfile, environment, 1, `Dockerfile missing exact environment: ${environment}`);
  }
  requireExactBlock(
    failures,
    dockerfile,
    "    && /usr/local/bin/verify-zuuli-store-capture-image",
    1,
    "Dockerfile must execute its inventory verifier during build",
  );

  for (const check of [
    "set -euo pipefail",
    '[[ "$(uname -m)" == "x86_64" ]]',
    '[[ "$(rustc +1.97.1 --version)" == rustc\\ 1.97.1\\ * ]]',
    '[[ "$(cargo +1.97.1 --version)" == cargo\\ 1.97.1\\ * ]]',
    "rustup target list --installed --toolchain 1.97.1 \\\n  | grep -Fqx -- \"wasm32-unknown-unknown\"",
    `browser_count="$({ find /ms-playwright -type f \\
  \\( -path '*/chromium-*/*/chrome' -o -path '*/chromium-*/*/headless_shell' \\) \\
  -perm -0111 -print 2>/dev/null || true; } | awk 'NF { count += 1 } END { print count + 0 }')"`,
    `if (( browser_count < 1 )); then
  echo "pinned Playwright Chromium executable is unavailable" >&2
  exit 1
fi`,
  ]) {
    requireExactBlock(failures, verifier, check, 1, `inventory verifier missing exact check: ${check}`);
  }

  for (const path of [
    ".github/containers/zuuli-store-capture/**",
    ".github/workflows/zuuli-store-capture-image.yml",
    ".github/workflows/zuuli.yml",
    "docs/ZUULI-STORE-CAPTURE-IMAGE.md",
    "scripts/check-zuuli-store-capture-image.mjs",
  ]) {
    requireExactly(failures, workflow, `      - ${path}`, 2, `image workflow must trigger on ${path}`);
  }
  requireExactBlock(
    failures,
    workflow,
    `  IMAGE_NAME: ${imageRepository}`,
    1,
    "image workflow must publish only to the reviewed repository",
  );
  requireExactBlock(
    failures,
    workflow,
    "permissions:\n  contents: read",
    1,
    "image workflow must default to read-only repository permissions",
  );
  requireExactBlock(
    failures,
    workflow,
    "          persist-credentials: false",
    3,
    "every image workflow checkout must discard repository credentials",
  );

  const uses = [...workflow.matchAll(/^\s+(?:-\s+)?uses:\s+(\S+)/gm)].map(
    (match) => match[1],
  );
  for (const action of uses) {
    if (!allowedActions.has(action)) failures.push(`image workflow has unreviewed action ref: ${action}`);
  }
  for (const action of allowedActions) {
    if (!uses.includes(action)) failures.push(`image workflow is missing pinned action: ${action}`);
  }

  const jobsMarker = "\njobs:\n";
  const jobsStart = workflow.indexOf(jobsMarker);
  const jobNames = [];
  if (jobsStart >= 0) {
    const jobLines = workflow
      .slice(jobsStart + jobsMarker.length)
      .split("\n")
      .filter((line) => /^  \S/.test(line) && !line.trimStart().startsWith("#"));
    for (const line of jobLines) {
      const match = line.match(/^  (?:(?:"([^"]+)"|'([^']+)')|([a-zA-Z0-9_-]+)):\s*$/);
      if (!match) {
        failures.push(`image workflow has an unauditable top-level job declaration: ${line.trim()}`);
        continue;
      }
      jobNames.push(match[1] ?? match[2] ?? match[3]);
    }
  }
  const expectedJobs = ["validate", "pull-request-build", "publish"];
  if (JSON.stringify(jobNames) !== JSON.stringify(expectedJobs)) {
    failures.push(
      `image workflow job census drifted; expected ${expectedJobs.join(", ")}, found ${jobNames.join(", ")}`,
    );
  }
  if (/^\s*continue-on-error:/m.test(workflow)) {
    failures.push("image workflow must not soften any job or step failure");
  }
  if (/^\s*if:\s*(?:false|\$\{\{\s*false\s*\}\})\s*$/m.test(workflow)) {
    failures.push("image workflow must not statically disable any job or step");
  }

  const validate = jobBlock(workflow, "validate");
  const pullRequest = jobBlock(workflow, "pull-request-build");
  const publish = jobBlock(workflow, "publish");
  for (const invocation of [
    "          node scripts/check-zuuli-store-capture-image.mjs --self-test\n",
    "          node scripts/check-zuuli-store-capture-image.mjs\n",
  ]) {
    requireExactly(failures, validate, invocation, 1, `validate job missing ${invocation}`);
  }
  for (const policy of [
    "    if: github.event_name == 'pull_request'",
    "    needs: validate",
    "    permissions:\n      contents: read",
    "          platforms: linux/amd64",
    "          load: true",
    "          push: false",
    "          /usr/local/bin/verify-zuuli-store-capture-image",
  ]) {
    requireExactBlock(failures, pullRequest, policy, 1, `pull-request image job missing policy: ${policy}`);
  }
  if (/packages:\s*write|id-token:\s*write|attestations:\s*write/.test(pullRequest)) {
    failures.push("pull-request image job must not receive publication authority");
  }
  requireExactBlock(
    failures,
    publish,
    `    if: >-
      github.ref == 'refs/heads/main' &&
      (github.event_name == 'push' ||
      github.event_name == 'schedule' ||
      github.event_name == 'workflow_dispatch')`,
    1,
    "publish image job must retain its exact fail-closed main-only event condition",
  );
  for (const policy of [
    "    needs: validate",
    "      packages: write",
    "      id-token: write",
    "      attestations: write",
    "      artifact-metadata: write",
    "          push: true",
    "          sbom: true",
    "          provenance: mode=max",
    "          subject-digest: ${{ steps.publish.outputs.digest }}",
    '          docker pull "$IMAGE_NAME@$IMAGE_DIGEST"',
    '          docker run --rm "$IMAGE_NAME@$IMAGE_DIGEST" \\',
  ]) {
    requireExactBlock(failures, publish, policy, 1, `publish image job missing policy: ${policy}`);
  }

  for (const invocation of [
    "          node scripts/check-zuuli-store-capture-image.mjs --self-test\n",
    "          node scripts/check-zuuli-store-capture-image.mjs\n",
  ]) {
    requireExactly(failures, gate, invocation, 1, `required gate missing ${invocation}`);
  }
  for (const selector of [
    "|scripts/check-zuuli-store-capture-image.mjs|",
    "|.github/containers/zuuli-store-capture/*|",
    "|.github/workflows/zuuli-store-capture-image.yml|",
    "|docs/ZUULI-STORE-CAPTURE-IMAGE.md)",
  ]) {
    const actual = gate
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#") && line.includes(selector))
      .length;
    if (actual !== 1) failures.push(`required gate change selector missing ${selector}; expected 1, found ${actual}`);
  }

  return failures;
}

function replaceUnique(source, needle, replacement) {
  if (count(source, needle) !== 1) {
    throw new Error(`self-test fixture expected one occurrence of ${needle}`);
  }
  return source.replace(needle, replacement);
}

function assertValid(documents) {
  const failures = validateStoreCaptureImage(documents);
  if (failures.length) throw new Error(failures.join("\n"));
}

function selfTest(documents) {
  assertValid(documents);
  const mutants = [
    ["unpinned Rust base", "dockerfile", rustImage, "rust:1.97.1-slim-bookworm"],
    ["wrong Rust target toolchain", "dockerfile", "--toolchain 1.97.1", "--toolchain 1.97.0"],
    ["missing WASM target", "dockerfile", "wasm32-unknown-unknown", "wasm32-wasi"],
    ["unpinned Playwright base", "dockerfile", playwrightImage, "mcr.microsoft.com/playwright:latest"],
    ["missing rustup copy", "dockerfile", "COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup", "# removed rustup copy"],
    ["build skips inventory", "dockerfile", "    && /usr/local/bin/verify-zuuli-store-capture-image", "    && true"],
    ["verifier accepts another rustc", "verifier", "rustc\\ 1.97.1", "rustc\\ 1.97.0"],
    ["verifier skips installed target", "verifier", "rustup target list --installed --toolchain 1.97.1", "printf wasm32-unknown-unknown"],
    ["verifier disables fail-fast", "verifier", "set -euo pipefail", "set +e"],
    ["verifier neutralizes missing browser exit", "verifier", "  exit 1", "  true"],
    ["verifier comments out rustc check", "verifier", '[[ "$(rustc +1.97.1 --version)"', '# [[ "$(rustc +1.97.1 --version)"'],
    ["Dockerfile comments out Rust base", "dockerfile", `FROM ${rustImage} AS rust-toolchain`, `# FROM ${rustImage} AS rust-toolchain`],
    ["PR image can publish", "workflow", "          push: false", "          push: true"],
    ["workflow defaults to writable contents", "workflow", "permissions:\n  contents: read\n\nconcurrency:", "permissions:\n  contents: write\n\nconcurrency:"],
    ["checkout retains credentials", "workflow", "        with:\n          persist-credentials: false\n      - run: |", "        with:\n          persist-credentials: true\n      - run: |"],
    ["publication moves off main", "workflow", "github.ref == 'refs/heads/main'", "github.ref == 'refs/heads/release'"],
    ["PR build drops validation dependency", "workflow", "    if: github.event_name == 'pull_request'\n    needs: validate", "    if: github.event_name == 'pull_request'\n    # needs: validate"],
    ["publication drops validation dependency", "workflow", "      github.event_name == 'workflow_dispatch')\n    needs: validate", "      github.event_name == 'workflow_dispatch')\n    # needs: validate"],
    ["publication condition becomes tautological", "workflow", "      github.event_name == 'workflow_dispatch')", "      github.event_name == 'workflow_dispatch' || true)"],
    ["unexpected publishing job appears", "workflow", "\n  publish:\n", "\n  rogue-publish:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: docker push example.invalid/image\n\n  publish:\n"],
    ["quoted publishing job evades census", "workflow", "\n  publish:\n", "\n  'rogue-publish':\n    runs-on: ubuntu-24.04\n    steps:\n      - run: docker push example.invalid/image\n\n  publish:\n"],
    ["attestation can fail softly", "workflow", "        uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2", "        uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2\n        continue-on-error: true"],
    ["digest verification is statically skipped", "workflow", "      - name: Verify the published digest and inventory", "      - name: Verify the published digest and inventory\n        if: false"],
    ["publication omits SBOM", "workflow", "          sbom: true", "          sbom: false"],
    ["publication omits provenance", "workflow", "          provenance: mode=max", "          provenance: false"],
    ["attestation action removed", "workflow", "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6", "actions/attest@main"],
    ["required gate skips self-test", "gate", "          node scripts/check-zuuli-store-capture-image.mjs --self-test\n", ""],
    ["required gate misses container changes", "gate", ".github/containers/zuuli-store-capture/*|", ""],
  ];

  for (const [name, document, needle, replacement] of mutants) {
    const mutant = { ...documents };
    mutant[document] = replaceUnique(mutant[document], needle, replacement);
    const failures = validateStoreCaptureImage(mutant);
    if (failures.length === 0) throw new Error(`self-test mutant survived: ${name}`);
  }
  console.log(`Store-capture image policy self-test passed (${mutants.length} mutants killed).`);
}

const documents = readTree();
if (process.argv.length === 3 && process.argv[2] === "--self-test") {
  selfTest(documents);
} else if (process.argv.length === 2) {
  assertValid(documents);
  console.log("Store-capture image policy passed.");
} else {
  console.error("usage: node scripts/check-zuuli-store-capture-image.mjs [--self-test]");
  process.exit(2);
}
