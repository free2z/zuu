#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";

const BUILD_JOBS = ["android-build", "ios-build", "macos-build"];
const CREDENTIAL_JOBS = ["android-sign-upload", "ios-sign", "ios-upload", "macos-sign"];
const FINALIZE_JOBS = ["android-finalize", "ios-verify", "ios-finalize", "macos-finalize"];
const RELEASE_JOBS = [
  "prepare",
  "android-build",
  "android-sign-upload",
  "android-finalize",
  "ios-build",
  "ios-sign",
  "ios-verify",
  "ios-upload",
  "ios-finalize",
  "linux",
  "macos-build",
  "macos-sign",
  "macos-finalize",
  "release-index",
];
const ROOT_KEYS = ["name", "on", "permissions", "concurrency", "env", "jobs"];
const RELEASE_TARGET_JOBS = new Map([
  ["mobile", ["android-build", "android-sign-upload", "android-finalize", "ios-finalize"]],
  ["ios", ["ios-finalize"]],
  ["android", ["android-build", "android-sign-upload", "android-finalize"]],
  ["desktop", ["linux", "macos-finalize"]],
  ["all", ["android-build", "android-sign-upload", "android-finalize", "ios-finalize", "linux", "macos-finalize"]],
]);
const RELEASE_TERMINAL_JOBS = [
  "android-build",
  "android-sign-upload",
  "android-finalize",
  "ios-finalize",
  "linux",
  "macos-finalize",
];
const RELEASE_INDEX_CONDITION = `
  always() && !cancelled() &&
  needs.prepare.result == 'success' &&
  needs.prepare.outputs.should_release == 'true' &&
  (((needs.prepare.outputs.target == 'mobile' ||
  needs.prepare.outputs.target == 'android' ||
  needs.prepare.outputs.target == 'all') &&
  needs.android-build.result == 'success' &&
  needs.android-sign-upload.result == 'success' &&
  needs.android-finalize.result == 'success') ||
  ((needs.prepare.outputs.target != 'mobile' &&
  needs.prepare.outputs.target != 'android' &&
  needs.prepare.outputs.target != 'all') &&
  needs.android-build.result == 'skipped' &&
  needs.android-sign-upload.result == 'skipped' &&
  needs.android-finalize.result == 'skipped')) &&
  ((((needs.prepare.outputs.target == 'mobile' ||
  needs.prepare.outputs.target == 'ios' ||
  needs.prepare.outputs.target == 'all') &&
  needs.ios-finalize.result == 'success') ||
  ((needs.prepare.outputs.target == 'android' ||
  needs.prepare.outputs.target == 'desktop') &&
  needs.ios-finalize.result == 'skipped'))) &&
  ((((needs.prepare.outputs.target == 'desktop' ||
  needs.prepare.outputs.target == 'all') &&
  needs.linux.result == 'success' &&
  needs.macos-finalize.result == 'success') ||
  ((needs.prepare.outputs.target == 'mobile' ||
  needs.prepare.outputs.target == 'ios' ||
  needs.prepare.outputs.target == 'android') &&
  needs.linux.result == 'skipped' &&
  needs.macos-finalize.result == 'skipped')))
`.replace(/\s+/g, " ").trim();
const ALLOWED_JOB_SECRETS = new Map([
  ["android-sign-upload", new Set([
    "ANDROID_KEYSTORE_BASE64",
    "PLAY_SERVICE_ACCOUNT_JSON_BASE64",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
    "ANDROID_KEY_PASSWORD",
  ])],
  ["ios-sign", new Set([
    "APPLE_DISTRIBUTION_CERTIFICATE_BASE64",
    "APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD",
    "APPLE_PROVISIONING_PROFILE_BASE64",
  ])],
  ["ios-upload", new Set(["ASC_KEY_BASE64"])],
  ["macos-sign", new Set([
    "APPLE_DEVELOPER_ID_CERTIFICATE_BASE64",
    "APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD",
    "APPLE_DEVELOPER_ID_PROVISIONING_PROFILE_BASE64",
    "ASC_KEY_BASE64",
  ])],
]);

// Each protected job is an exact reviewed execution program. These hashes are
// deliberately opaque tripwires: any step, action input, interpreter, shell,
// job-level default, or command change requires a visible policy update. The
// semantic checks below explain the major boundaries, while the digest closes
// all unenumerated execution paths. Update only after reviewing the full job.
const CREDENTIAL_JOB_SHA256 = new Map([
  ["android-sign-upload", "75fdef979a86d93f3d623a7cd04fc8058d74a6fb073f7bdeff559d98c707a6fa"],
  ["ios-sign", "6e63107606388e3862f81e41da65b1fa8bfca1588b5232f9ca4354203536393c"],
  ["ios-upload", "3ed7cb28646aed24a7df2c347b8ad54838f009841fdd52c64ca1002886aae4b2"],
  ["macos-sign", "1373f642a57f24f1943020f0123ab1c58a05bde81ca545e7fd3633678e09e857"],
]);
// The credential-free builder is also exact: its source-identity check and
// compile happen in separate steps, so an unreviewed command between them
// could otherwise build stale bytes while attesting the requested source SHA.
const ANDROID_BUILD_JOB_SHA256 =
  "0f26565c53eb7d7756757b391dfaee19d3b794392c8f0fec49e15f161aded398";
const ANDROID_FINALIZER_JOB_SHA256 =
  "9571bb82e1fa0ba6b0749fbbb9487f72e9c495fb0c6877f64747f0c3eff2f794";
const RELEASE_INDEX_JOB_SHA256 =
  "3765b21cca6396c81195bf9a29de2d6ad9315dc84596f27436be0c37748550a5";
const GITHUB_RELEASE_PUBLISHER_SHA256 =
  "a3ea3748e271af6bd253babdaf12687ea41c7812ded62fe2935de72305ba7a25";
const GITHUB_RELEASE_PUBLISHER_EXECUTABLE_SHA256 =
  "ae8280467a83ee2b2cd479d83ce03046bdcad940752f1b68ee2bf34d329b4df5";
const GITHUB_RELEASE_PUBLISHER_EXECUTABLE_PROGRAM = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "umask 077",
  "if [[ $# -ne 4 ]]; then",
  'echo "usage: scripts/publish-github-release.sh <tag> <identity> <expected-commit> <artifact-root>" >&2',
  "exit 64",
  "fi",
  "tag=$1",
  "identity=$2",
  "expected_commit=$3",
  "artifact_root=$4",
  '[[ -d "$artifact_root" ]] || { echo "artifact root does not exist: $artifact_root" >&2; exit 66; }',
  'script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)',
  'tag_identity="$artifact_root/release-index/release-tag-identity.json"',
  'verification_copy=$(mktemp "${TMPDIR:-/tmp}/zuuli-release-tag-identity.XXXXXX")',
  "trap 'rm -f \"$verification_copy\"' EXIT",
  '"$script_dir/verify-release-tag.sh" "$tag" "$expected_commit" "$tag_identity"',
  "reverify_tag_identity() {",
  '"$script_dir/verify-release-tag.sh" "$tag" "$expected_commit" "$verification_copy"',
  'cmp -s "$tag_identity" "$verification_copy" || {',
  'echo "release tag identity changed during publication" >&2',
  "exit 75",
  "}",
  "}",
  'if ! gh release view "$tag" >/dev/null 2>&1; then',
  'gh release create "$tag" --verify-tag --draft \\',
  '--title "ZUULI $identity" \\',
  '--notes "Immutable ZUULI $identity release candidate. Store promotion evidence is attached; keep draft until physical-device verification passes."',
  'elif [[ "$(gh release view "$tag" --json isDraft --jq .isDraft)" != true ]]; then',
  'echo "release $tag is already published; refusing to mutate it" >&2',
  "exit 73",
  "fi",
  "reverify_tag_identity",
  'package_dir=$(mktemp -d "${TMPDIR:-/tmp}/zuuli-github-release.XXXXXX")',
  'for directory in "$artifact_root"/*; do',
  '[[ -d "$directory" ]] || continue',
  'name=$(basename "$directory")',
  'archive="$package_dir/$name.tar.gz"',
  "tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \\",
  '-cf - -C "$directory" . | gzip -n > "$archive"',
  'comparison_dir=$(mktemp -d "${TMPDIR:-/tmp}/zuuli-release-compare.XXXXXX")',
  'if gh release download "$tag" --pattern "$name.tar.gz" --dir "$comparison_dir" >/dev/null 2>&1; then',
  'existing="$comparison_dir/$name.tar.gz"',
  'if [[ "$(shasum -a 256 "$existing" | cut -d \' \' -f 1)" != "$(shasum -a 256 "$archive" | cut -d \' \' -f 1)" ]]; then',
  'echo "release asset collision for $name.tar.gz; refusing overwrite" >&2',
  "exit 73",
  "fi",
  'echo "$name.tar.gz already exists with the same checksum; keeping it"',
  "else",
  "reverify_tag_identity",
  'gh release upload "$tag" "$archive"',
  "fi",
  "done",
  "reverify_tag_identity",
].join("\n");
const GITHUB_RELEASE_PUBLISHER_CRITICAL_SEQUENCE = [
  '"$script_dir/verify-release-tag.sh" "$tag" "$expected_commit" "$tag_identity"',
  '"$script_dir/verify-release-tag.sh" "$tag" "$expected_commit" "$verification_copy"',
  'if ! gh release view "$tag" >/dev/null 2>&1; then',
  'gh release create "$tag" --verify-tag --draft \\',
  'elif [[ "$(gh release view "$tag" --json isDraft --jq .isDraft)" != true ]]; then',
  "reverify_tag_identity",
  'if gh release download "$tag" --pattern "$name.tar.gz" --dir "$comparison_dir" >/dev/null 2>&1; then',
  "reverify_tag_identity",
  'gh release upload "$tag" "$archive"',
  "reverify_tag_identity",
];

// These four inherited/root controls sit outside the protected job nodes but
// can change when or how they execute. Bind their exact reviewed YAML source so
// triggers, global permissions, serialization, and inherited environment
// cannot drift around the credential-job program seals.
const ROOT_AUTHORITY_SHA256 = new Map([
  ["on", "c58b4535da1019427311bdfdc1bcc62d083a9458e4d9746f1e8ee0e841b23ebe"],
  ["permissions", "248e857abefa9bcd48e29bf205c0ba2260ad4c167937fe37b5506afec6569d6c"],
  ["concurrency", "9e63d742d3a1d8bf26f2f8d8b77427f2bac2d28142d17eecaa75fafc7f95f4f5"],
  ["env", "d905f9175e5d70ba3b4459bae14bc895f75b97bfb48b91ff764c2d9c382386ca"],
]);

function requireText(failures, label, source, needle) {
  if (!source.includes(needle)) failures.push(`${label} is missing ${JSON.stringify(needle)}`);
}

function rejectText(failures, label, source, needle) {
  if (source.includes(needle)) failures.push(`${label} contains forbidden ${JSON.stringify(needle)}`);
}

export function releaseIndexResultsAreComplete(target, results) {
  const selected = RELEASE_TARGET_JOBS.get(target);
  if (!selected) return false;
  const selectedJobs = new Set(selected);
  return RELEASE_TERMINAL_JOBS.every(
    (job) => results[job] === (selectedJobs.has(job) ? "success" : "skipped"),
  );
}

function secretExpressions(source) {
  return [...source.matchAll(/\$\{\{[\s\S]*?\}\}/g)]
    .filter((match) => /\bsecrets\b/i.test(match[0]));
}

function scalarKey(pair) {
  return isScalar(pair?.key) && typeof pair.key.value === "string" ? pair.key.value : null;
}

function pairFor(map, key) {
  return isMap(map) ? map.items.find((pair) => scalarKey(pair) === key) : undefined;
}

function scalarValue(map, key) {
  const value = pairFor(map, key)?.value;
  return isScalar(value) && typeof value.value === "string" ? value.value : null;
}

function scalarEquals(map, key, expected) {
  const value = pairFor(map, key)?.value;
  return isScalar(value) && value.value === expected;
}

function exactMapKeys(map, expected) {
  if (!isMap(map)) return false;
  const actual = map.items.map(scalarKey);
  return actual.length === expected.length &&
    expected.every((key) => actual.includes(key));
}

function exactScalarSequence(sequence, expected) {
  return isSeq(sequence) &&
    sequence.items.length === expected.length &&
    sequence.items.every(
      (item, index) => isScalar(item) && item.value === expected[index],
    );
}

function exactReleaseIndexJob(node) {
  const permissions = pairFor(node, "permissions")?.value;
  return (
    exactMapKeys(node, [
      "name",
      "needs",
      "if",
      "runs-on",
      "timeout-minutes",
      "permissions",
      "steps",
    ]) &&
    scalarEquals(node, "name", "Immutable GitHub release index") &&
    exactScalarSequence(pairFor(node, "needs")?.value, [
      "prepare",
      "android-build",
      "android-sign-upload",
      "android-finalize",
      "ios-finalize",
      "linux",
      "macos-finalize",
    ]) &&
    scalarEquals(node, "runs-on", "ubuntu-24.04") &&
    scalarEquals(node, "timeout-minutes", 20) &&
    exactMapKeys(permissions, ["contents"]) &&
    scalarEquals(permissions, "contents", "write") &&
    exactReleaseIndexSteps(node)
  );
}

export function githubReleasePublisherDigest(source) {
  return sha256(source);
}

export function githubReleasePublisherExecutableDigest(source) {
  return sha256(githubReleasePublisherExecutableProgram(source));
}

function githubReleasePublisherExecutableProgram(source) {
  const executableLines = [];
  let continued = false;
  for (const [index, rawLine] of source.split("\n").entries()) {
    const line = rawLine.trim();
    const comment = line.startsWith("#");
    const inert = line.length === 0 || comment;
    // Bash removes backslash-newline pairs before recognizing comments. A
    // blank/comment line inside a continuation, or a comment ending in a
    // backslash, can therefore suppress the next reviewed statement even
    // though a naive comment filter would show the same apparent program.
    if ((continued && inert) || (comment && /\\[ \t]*$/.test(rawLine))) {
      executableLines.push(`<unsafe-continuation:${index + 1}>`);
    }
    if (index === 0 || !inert) executableLines.push(line);
    continued = !comment && /\\[ \t]*$/.test(rawLine);
  }
  return executableLines.join("\n");
}

export function verifyGithubReleasePublisher(
  source,
  {
    expectedDigest = GITHUB_RELEASE_PUBLISHER_SHA256,
    expectedExecutableDigest = GITHUB_RELEASE_PUBLISHER_EXECUTABLE_SHA256,
  } = {},
) {
  const failures = [];
  const actualDigest = sha256(source);
  if (actualDigest !== expectedDigest) {
    failures.push(
      `GitHub release publisher execution program changed: expected ${expectedDigest}, got ${actualDigest}`,
    );
  }
  const executableDigest = githubReleasePublisherExecutableDigest(source);
  if (executableDigest !== expectedExecutableDigest) {
    failures.push(
      `GitHub release publisher executable program changed: expected ${expectedExecutableDigest}, got ${executableDigest}`,
    );
  }

  const executableProgram = githubReleasePublisherExecutableProgram(source);
  if (executableProgram !== GITHUB_RELEASE_PUBLISHER_EXECUTABLE_PROGRAM) {
    failures.push(
      "GitHub release publisher executable statements differ from the exact reviewed program",
    );
  }

  const executableLines = executableProgram.split("\n");
  const criticalLines = new Set(GITHUB_RELEASE_PUBLISHER_CRITICAL_SEQUENCE);
  const actualCriticalSequence = executableLines.filter((line) => criticalLines.has(line));
  if (
    JSON.stringify(actualCriticalSequence) !==
      JSON.stringify(GITHUB_RELEASE_PUBLISHER_CRITICAL_SEQUENCE)
  ) {
    failures.push(
      "GitHub release publisher verification and publication boundaries changed order or count",
    );
  }
  const uploadIndex = executableLines.indexOf('gh release upload "$tag" "$archive"');
  if (uploadIndex < 1 || executableLines[uploadIndex - 1] !== "reverify_tag_identity") {
    failures.push(
      "GitHub release upload must be immediately preceded by tag-identity re-verification",
    );
  }
  return failures;
}

function exactReleaseIndexSteps(node) {
  const steps = pairFor(node, "steps")?.value;
  if (!isSeq(steps) || steps.items.length !== 5 || steps.items.some((step) => !isMap(step))) {
    return false;
  }
  const [checkout, download, verifier, publish, upload] = steps.items;
  const checkoutWith = pairFor(checkout, "with")?.value;
  const downloadWith = pairFor(download, "with")?.value;
  const verifierEnv = pairFor(verifier, "env")?.value;
  const publishEnv = pairFor(publish, "env")?.value;
  const uploadWith = pairFor(upload, "with")?.value;
  return (
    exactMapKeys(checkout, ["uses", "with"]) &&
    scalarEquals(
      checkout,
      "uses",
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    ) &&
    exactMapKeys(checkoutWith, ["ref", "fetch-depth", "fetch-tags", "persist-credentials"]) &&
    scalarEquals(checkoutWith, "ref", "${{ needs.prepare.outputs.source_sha }}") &&
    scalarEquals(checkoutWith, "fetch-depth", 0) &&
    scalarEquals(checkoutWith, "fetch-tags", true) &&
    scalarEquals(checkoutWith, "persist-credentials", false) &&
    exactMapKeys(download, ["uses", "with"]) &&
    scalarEquals(
      download,
      "uses",
      "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131",
    ) &&
    exactMapKeys(downloadWith, ["pattern", "path", "merge-multiple"]) &&
    scalarEquals(
      downloadWith,
      "pattern",
      "zuuli-{android,ios,linux,macos}-${{ needs.prepare.outputs.identity }}-${{ needs.prepare.outputs.source_sha }}",
    ) &&
    scalarEquals(downloadWith, "path", "release-downloads") &&
    scalarEquals(downloadWith, "merge-multiple", false) &&
    exactMapKeys(verifier, ["name", "env", "run"]) &&
    scalarEquals(verifier, "name", "Verify release-index source binding") &&
    exactMapKeys(verifierEnv, ["RELEASE_IDENTITY", "EXPECTED_SOURCE_SHA", "RELEASE_TARGET"]) &&
    scalarEquals(verifierEnv, "RELEASE_IDENTITY", "${{ needs.prepare.outputs.identity }}") &&
    scalarEquals(verifierEnv, "EXPECTED_SOURCE_SHA", "${{ needs.prepare.outputs.source_sha }}") &&
    scalarEquals(verifierEnv, "RELEASE_TARGET", "${{ needs.prepare.outputs.target }}") &&
    scalarEquals(
      verifier,
      "run",
      'wallet/zuuli/scripts/verify-release-index.sh release-downloads "$RELEASE_IDENTITY" "$EXPECTED_SOURCE_SHA" "$RELEASE_TARGET"',
    ) &&
    exactMapKeys(publish, ["name", "if", "env", "run"]) &&
    scalarEquals(publish, "name", "Publish idempotent draft release") &&
    scalarEquals(
      publish,
      "if",
      "needs.prepare.outputs.dry_run == 'false' && needs.prepare.outputs.tag_exists == 'true'",
    ) &&
    exactMapKeys(publishEnv, [
      "GH_TOKEN",
      "RELEASE_TAG",
      "RELEASE_IDENTITY",
      "RELEASE_SOURCE_SHA",
    ]) &&
    scalarEquals(publishEnv, "GH_TOKEN", "${{ github.token }}") &&
    scalarEquals(publishEnv, "RELEASE_TAG", "${{ needs.prepare.outputs.tag }}") &&
    scalarEquals(publishEnv, "RELEASE_IDENTITY", "${{ needs.prepare.outputs.identity }}") &&
    scalarEquals(publishEnv, "RELEASE_SOURCE_SHA", "${{ needs.prepare.outputs.source_sha }}") &&
    scalarEquals(
      publish,
      "run",
      'wallet/zuuli/scripts/publish-github-release.sh "$RELEASE_TAG" "$RELEASE_IDENTITY" "$RELEASE_SOURCE_SHA" release-downloads',
    ) &&
    exactMapKeys(upload, ["uses", "with"]) &&
    scalarEquals(
      upload,
      "uses",
      "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f",
    ) &&
    exactMapKeys(uploadWith, ["name", "path", "if-no-files-found", "retention-days"]) &&
    scalarEquals(
      uploadWith,
      "name",
      "zuuli-release-index-${{ needs.prepare.outputs.identity }}-${{ needs.prepare.outputs.source_sha }}",
    ) &&
    scalarEquals(uploadWith, "path", "release-downloads") &&
    scalarEquals(uploadWith, "if-no-files-found", "error") &&
    scalarEquals(uploadWith, "retention-days", 90)
  );
}

function sourceForNode(workflow, node) {
  return node?.range ? workflow.slice(node.range[0], node.range[2]) : "";
}

function containsBareBashDoubleBracket(source) {
  // Bash treats a failing `[[ ]]` in statement position as exempt from
  // `errexit` on the macOS runner's Bash 3.2. Join explicit continuations,
  // then inspect command boundaries rather than only whole lines: a bare test
  // after `then`, `do`, a group opener, or an AND/OR list is just as inert.
  // `[[` can also continue implicitly across a newline while its expression
  // is incomplete. Deliberate conditions introduced by `if`, `while`, `!`,
  // etc. do not begin at one of these boundaries and remain allowed.
  const shell = source.replace(/\\\r?\n[\t ]*/g, " ");
  const starts =
    /(?:^|[;\n]|(?<!&)&(?!&)|&&|\|\||\bthen\b|\bdo\b|\belse\b|\btime\b(?:[\t ]+-p)?|[({)])[\t ]*\[\[/gm;
  for (const match of shell.matchAll(starts)) {
    const open = match.index + match[0].lastIndexOf("[[");
    let quote = null;
    let close = -1;
    for (let index = open + 2; index < shell.length; index += 1) {
      const char = shell[index];
      if (char === "\\" && quote !== "'") {
        index += 1;
        continue;
      }
      if (quote) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        continue;
      }
      if (char === "]" && shell[index + 1] === "]") {
        close = index;
        break;
      }
    }
    if (close < 0) return true;
    const continuation = shell.slice(close + 2).match(/^[\t ]*(\|\||&&)/);
    if (!continuation) return true;
  }
  return false;
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function inspectYamlNode(node, failures, path = "workflow") {
  if (!node) return;
  if (node.anchor) failures.push(`${path} contains forbidden YAML anchor ${JSON.stringify(node.anchor)}`);
  if (isAlias(node)) {
    failures.push(`${path} contains forbidden YAML alias ${JSON.stringify(node.source)}`);
    return;
  }
  if (isMap(node)) {
    for (const [index, pair] of node.items.entries()) {
      const token = node.srcToken?.items?.[index];
      if (token?.explicitKey) failures.push(`${path} contains forbidden explicit YAML mapping key`);
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        failures.push(`${path} contains a non-string or complex YAML mapping key`);
      } else if (pair.key.tag) {
        failures.push(`${path}.${pair.key.value} contains forbidden tagged YAML mapping key`);
      }
      inspectYamlNode(pair.key, failures, `${path}.<key>`);
      inspectYamlNode(pair.value, failures, `${path}.${scalarKey(pair) ?? "<complex>"}`);
    }
  } else if (isSeq(node)) {
    node.items.forEach((item, index) => inspectYamlNode(item, failures, `${path}[${index}]`));
  }
}

function parseWorkflow(workflow, failures) {
  let document;
  try {
    document = parseDocument(workflow, {
      keepSourceTokens: true,
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
  } catch (error) {
    failures.push(`workflow YAML parser threw: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  for (const error of document.errors) failures.push(`workflow YAML is invalid: ${error.message}`);
  for (const warning of document.warnings) failures.push(`workflow YAML warning is forbidden: ${warning.message}`);
  if (document.errors.length > 0 || document.warnings.length > 0) return null;
  inspectYamlNode(document.contents, failures);
  if (!isMap(document.contents)) {
    failures.push("workflow root must be a YAML mapping");
    return null;
  }
  const jobs = pairFor(document.contents, "jobs")?.value;
  if (!isMap(jobs)) {
    failures.push("workflow jobs must be a YAML mapping");
    return null;
  }
  return { document, jobs };
}

export function credentialJobDigests(workflow) {
  const failures = [];
  const parsed = parseWorkflow(workflow, failures);
  if (!parsed || failures.length > 0) throw new Error(failures.join("\n"));
  return new Map(CREDENTIAL_JOBS.map((name) => {
    const node = pairFor(parsed.jobs, name)?.value;
    if (!node) throw new Error(`workflow is missing credential job ${name}`);
    return [name, sha256(sourceForNode(workflow, node))];
  }));
}

export function releaseAuthorityDigests(workflow) {
  const failures = [];
  const parsed = parseWorkflow(workflow, failures);
  if (!parsed || failures.length > 0) throw new Error(failures.join("\n"));
  return new Map([...ROOT_AUTHORITY_SHA256.keys()].map((name) => {
    const node = pairFor(parsed.document.contents, name)?.value;
    if (!node) throw new Error(`workflow is missing root authority ${name}`);
    return [name, sha256(sourceForNode(workflow, node))];
  }));
}

export function androidFinalizerJobDigest(workflow) {
  const failures = [];
  const parsed = parseWorkflow(workflow, failures);
  if (!parsed || failures.length > 0) throw new Error(failures.join("\n"));
  const node = pairFor(parsed.jobs, "android-finalize")?.value;
  if (!node) throw new Error("workflow is missing android-finalize");
  return sha256(sourceForNode(workflow, node));
}

export function androidBuildJobDigest(workflow) {
  const failures = [];
  const parsed = parseWorkflow(workflow, failures);
  if (!parsed || failures.length > 0) throw new Error(failures.join("\n"));
  const node = pairFor(parsed.jobs, "android-build")?.value;
  if (!node) throw new Error("workflow is missing android-build");
  return sha256(sourceForNode(workflow, node));
}

export function releaseIndexJobDigest(workflow) {
  const failures = [];
  const parsed = parseWorkflow(workflow, failures);
  if (!parsed || failures.length > 0) throw new Error(failures.join("\n"));
  const node = pairFor(parsed.jobs, "release-index")?.value;
  if (!node) throw new Error("workflow is missing release-index");
  return sha256(sourceForNode(workflow, node));
}

/**
 * Enforce the source-level mobile/desktop release authority boundary.
 *
 * Build jobs may execute repository and dependency code, so they must have no
 * protected environment or secret expressions. Credential jobs may use only
 * already-built, checksum-verified artifacts and Apple/system release tools;
 * they may not check out or build repository code. Finalization happens after
 * credentials are destroyed in separate credential-free jobs.
 */
export function verifyAppleCredentialBoundary(
  workflow,
  {
    credentialJobDigests = CREDENTIAL_JOB_SHA256,
    rootAuthorityDigests = ROOT_AUTHORITY_SHA256,
    expectedAndroidBuildDigest = ANDROID_BUILD_JOB_SHA256,
    expectedAndroidFinalizerDigest = ANDROID_FINALIZER_JOB_SHA256,
    expectedReleaseIndexDigest = RELEASE_INDEX_JOB_SHA256,
  } = {},
) {
  const failures = [];
  const parsed = parseWorkflow(workflow, failures);
  if (!parsed) return failures;
  const jobNodes = new Map();
  const jobs = new Map();
  for (const pair of parsed.jobs.items) {
    const name = scalarKey(pair);
    if (name && pair.value) {
      jobNodes.set(name, pair.value);
      jobs.set(name, sourceForNode(workflow, pair.value));
    }
  }

  const rootNames = parsed.document.contents.items.map((pair) => scalarKey(pair));
  if (
    rootNames.length !== ROOT_KEYS.length ||
    ROOT_KEYS.some((name) => !rootNames.includes(name))
  ) {
    failures.push(`workflow root keys must be exactly ${ROOT_KEYS.join(", ")}`);
  }
  const workflowName = pairFor(parsed.document.contents, "name")?.value;
  if (!isScalar(workflowName) || workflowName.value !== "ZUULI / protected release") {
    failures.push("workflow name must be exactly ZUULI / protected release");
  }
  for (const [name, expectedDigest] of rootAuthorityDigests) {
    const node = pairFor(parsed.document.contents, name)?.value;
    const actualDigest = node ? sha256(sourceForNode(workflow, node)) : null;
    if (actualDigest !== expectedDigest) {
      failures.push(
        `workflow root ${name} authority changed: expected ${expectedDigest}, got ${actualDigest ?? "missing"}`,
      );
    }
  }

  const actualJobNames = [...jobs.keys()];
  if (
    actualJobNames.length !== RELEASE_JOBS.length ||
    RELEASE_JOBS.some((name) => !jobs.has(name))
  ) {
    failures.push(`workflow jobs must be exactly ${RELEASE_JOBS.join(", ")}`);
  }
  for (const [name, node] of jobNodes) {
    if (pairFor(node, "uses")) failures.push(`${name} contains forbidden reusable-workflow uses`);
    if (pairFor(node, "secrets")) failures.push(`${name} contains forbidden job-level secrets forwarding`);
  }

  for (const name of [...BUILD_JOBS, ...CREDENTIAL_JOBS, ...FINALIZE_JOBS]) {
    if (!jobs.has(name)) failures.push(`workflow is missing required job ${name}`);
  }
  for (const name of [...BUILD_JOBS, ...CREDENTIAL_JOBS, ...FINALIZE_JOBS]) {
    const source = jobs.get(name) ?? "";
    if (containsBareBashDoubleBracket(source)) {
      failures.push(`${name} contains a bare Bash [[ ]] assertion that does not fail closed on macOS Bash 3.2`);
    }
  }
  if (failures.length > 0) return failures;

  // Preserve the immutable Linux image consumer contract without making the
  // token available to any job step: exactly this container pull field may
  // reference it, once.
  const linuxContainer = pairFor(jobNodes.get("linux"), "container")?.value;
  const linuxCredentials = pairFor(linuxContainer, "credentials")?.value;
  const linuxPassword = pairFor(linuxCredentials, "password")?.value;
  const linuxPasswordValue = isScalar(linuxPassword) ? linuxPassword.value : null;
  if (linuxPasswordValue !== "${{ secrets.GITHUB_TOKEN }}") {
    failures.push("linux container pull password must be exactly secrets.GITHUB_TOKEN");
  }
  let linuxPullCredentialOccurrences = 0;
  for (const expression of secretExpressions(workflow)) {
    const job = [...jobNodes].find(([, node]) =>
      node.range && expression.index >= node.range[0] && expression.index < node.range[2]
    )?.[0];
    const body = expression[0].slice(3, -2).trim();
    const exact = body.match(/^secrets\.([A-Z0-9_]+)$/);
    const isLinuxPullCredential =
      job === "linux" &&
      exact?.[1] === "GITHUB_TOKEN" &&
      linuxPassword?.range &&
      expression.index >= linuxPassword.range[0] &&
      expression.index < linuxPassword.range[2];
    if (isLinuxPullCredential) linuxPullCredentialOccurrences += 1;
    const allowed =
      isLinuxPullCredential ||
      (job && exact && ALLOWED_JOB_SECRETS.get(job)?.has(exact[1]));
    if (!allowed) {
      failures.push(
        `${job ?? "workflow"} contains unauthorized secrets-context expression ${JSON.stringify(expression[0])}`,
      );
    }
  }
  if (linuxPullCredentialOccurrences !== 1) {
    failures.push(
      `linux container pull credential must occur exactly once, found ${linuxPullCredentialOccurrences}`,
    );
  }
  for (const name of BUILD_JOBS) {
    const source = jobs.get(name);
    if (pairFor(jobNodes.get(name), "environment")) failures.push(`${name} contains forbidden protected environment`);
    requireText(failures, name, source, "actions/checkout@");
    requireText(failures, name, source, "actions/attest-build-provenance@");
    requireText(failures, name, source, "actions/upload-artifact@");
    const android = name === "android-build";
    const canary = android
      ? "scripts/assert-no-android-credentials.sh"
      : "scripts/assert-no-apple-credentials.sh";
    const firstCanary = source.indexOf(canary);
    const dependencyInstall = source.indexOf("npm ci");
    const unsignedBuild = android
      ? source.indexOf("tauri android build --ci --aab")
      : source.indexOf("--no-sign");
    const inlineCanary = android ? source.indexOf(canary, dependencyInstall) : -1;
    const lastCanary = source.lastIndexOf(canary);
    if (!(firstCanary >= 0 && firstCanary < dependencyInstall)) {
      failures.push(`${name} must run the credential canary before dependency install`);
    }
    if (!(unsignedBuild >= 0 && unsignedBuild < lastCanary)) {
      failures.push(`${name} must run the credential canary after the unsigned build`);
    }
    if (android && !(
      source.split(canary).length - 1 === 3 &&
      dependencyInstall < inlineCanary && inlineCanary < unsignedBuild && unsignedBuild < lastCanary
    )) {
      failures.push("android-build must reject step-local Android authority immediately before the AAB build");
    }
  }

  for (const name of CREDENTIAL_JOBS) {
    const source = jobs.get(name);
    const environment = pairFor(jobNodes.get(name), "environment")?.value;
    if (!isScalar(environment) || environment.value !== "zuuli-app-stores") {
      failures.push(`${name} must use exactly the protected zuuli-app-stores environment`);
    }
    const expectedDigest = credentialJobDigests.get(name);
    const actualDigest = sha256(source);
    if (!expectedDigest || actualDigest !== expectedDigest) {
      failures.push(
        `${name} credential execution program changed: expected ${expectedDigest ?? "no digest"}, got ${actualDigest}`,
      );
    }
    requireText(failures, name, source, "actions/download-artifact@");
    rejectText(failures, name, source, "actions/checkout@");
    for (const forbidden of [
      "npm ci",
      "npm install",
      "cargo ",
      "./node_modules/",
      "tauri ",
      "pod install",
      "xcodebuild archive",
      "xcodebuild build",
      "node scripts/",
      "scripts/",
      "uses: ./.github/actions/",
      "actions/cache@",
    ]) {
      rejectText(failures, name, source, forbidden);
    }
    const firstSecret = secretExpressions(source)[0]?.index ?? -1;
    const download = source.indexOf("actions/download-artifact@");
    const verification = source.indexOf("Verify source-bound artifact");
    if (!(download >= 0 && download < verification && verification < firstSecret)) {
      failures.push(`${name} must verify its downloaded artifact before any secrets-context expression`);
    }
    const expressions = secretExpressions(source);
    const lastExpression = expressions.at(-1);
    const lastSecret = lastExpression ? lastExpression.index : -1;
    const lastDestroy = name === "android-sign-upload"
      ? source.indexOf("Destroy ephemeral Android credentials")
      : Math.max(
        source.lastIndexOf("Destroy ephemeral"),
        source.lastIndexOf("Destroy all ephemeral"),
      );
    const upload = source.lastIndexOf("actions/upload-artifact@");
    if (!(lastSecret < lastDestroy && lastDestroy < upload)) {
      failures.push(`${name} must destroy every credential class before artifact upload`);
    }
    requireText(failures, name, source, "if: always()");
  }

  const androidBuilder = jobs.get("android-build");
  const actualAndroidBuildDigest = sha256(androidBuilder);
  if (actualAndroidBuildDigest !== expectedAndroidBuildDigest) {
    failures.push(
      `android-build execution program changed: expected ${expectedAndroidBuildDigest}, got ${actualAndroidBuildDigest}`,
    );
  }
  for (const marker of [
    "aarch64-linux-android,armv7-linux-androideabi,i686-linux-android,x86_64-linux-android",
    "tauri android build --ci --aab -- --locked",
    "android-release-artifact.sh record",
    "android-release-artifact.sh seal-verifier",
    "jarsigner -verify",
    "unsigned-zuuli-android-",
  ]) requireText(failures, "Android unsigned builder", androidBuilder, marker);
  rejectText(failures, "Android unsigned builder", androidBuilder, "secrets.");

  const androidSigner = jobs.get("android-sign-upload");
  for (const marker of [
    "actions/setup-java@b6effb05e454b25005698d916606bdc6ffcbf961",
    'java-version: "21.0.12"',
    "Verify pinned Android signing JVM",
    "java -version 2>&1 | grep -F '21.0.12'",
  ]) requireText(failures, "Android protected signer/uploader", androidSigner, marker);
  if ([...androidSigner.matchAll(/actions\/download-artifact@/g)].length !== 1) {
    failures.push("Android protected signer/uploader must consume exactly one immutable workflow artifact");
  }
  for (const marker of [
    "EXPECTED_PAYLOAD_SHA256",
    "gh attestation verify unsigned-android/CHECKSUMS.sha256",
    "--source-digest \"$EXPECTED_SOURCE_SHA\"",
    "--source-ref refs/heads/main",
    'gh api "repos/$EXPECTED_REPOSITORY/git/commits/$EXPECTED_SOURCE_SHA" --jq .tree.sha',
    "bundletool-all-1.18.3.jar",
    "a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29",
    "arm64-v8a,armeabi-v7a,x86,x86_64",
    "jarsigner -keystore",
    "keytool -printcert -jarfile",
    "signed-aab-payload.sha256",
    "cmp \"$RUNNER_TEMP/unsigned-aab-payload.sha256\"",
    "androidpublisher.googleapis.com",
    "--retry 3 --retry-all-errors",
    "Destroy ephemeral Android credentials",
    "Destroy signed Android output",
  ]) requireText(failures, "Android protected signer/uploader", androidSigner, marker);
  for (const forbidden of [
    "actions/checkout@",
    "npm ci",
    "cargo ",
    "tauri ",
    "gradle",
    "sdkmanager",
    "rustup",
    "actions/cache@",
    "uses: ./.github/actions/",
  ]) rejectText(failures, "Android protected signer/uploader", androidSigner, forbidden);
  const androidVerify = androidSigner.indexOf("Verify source-bound artifact checksum and attestation");
  const androidJavaSetup = androidSigner.indexOf("actions/setup-java@b6effb05e454b25005698d916606bdc6ffcbf961");
  const androidJavaProof = androidSigner.indexOf("Verify pinned Android signing JVM");
  const androidDownload = androidSigner.indexOf("actions/download-artifact@");
  const androidAttestation = androidSigner.indexOf("gh attestation verify unsigned-android/CHECKSUMS.sha256");
  const androidInspection = androidSigner.indexOf("Inspect attested Android artifact without credentials");
  const androidBundleInspection = androidSigner.indexOf("dump manifest --bundle");
  const androidToolRemoval = androidSigner.indexOf('rm -f -- "$bundletool"');
  const androidFirstSecret = secretExpressions(androidSigner)[0]?.index ?? -1;
  rejectText(
    failures,
    "Android protected pre-secret verifier",
    androidSigner.slice(0, androidFirstSecret),
    "curl ",
  );
  if (!(androidJavaSetup >= 0 && androidJavaSetup < androidJavaProof && androidJavaProof < androidDownload && androidDownload < androidVerify && androidVerify < androidAttestation && androidAttestation < androidInspection && androidInspection < androidBundleInspection && androidBundleInspection < androidToolRemoval && androidToolRemoval < androidFirstSecret)) {
    failures.push("Android protected job must verify checksum, attestation, identity and ABIs, then remove verifier tooling before credentials");
  }
  const androidGithubTokens = [...androidSigner.matchAll(/GH_TOKEN: \$\{\{ github\.token \}\}/g)].map((match) => match.index);
  const androidGithubToken = androidGithubTokens[0] ?? -1;
  if (!(androidGithubTokens.length === 1 && androidVerify < androidGithubToken && androidGithubToken < androidAttestation && androidAttestation < androidInspection)) {
    failures.push("Android protected job must confine its GitHub token to pre-parser source and attestation verification");
  }
  const androidCredentialCleanup = androidSigner.indexOf("Destroy ephemeral Android credentials");
  const androidArtifactUpload = androidSigner.indexOf("actions/upload-artifact@");
  const androidSignedCleanup = androidSigner.indexOf("Destroy signed Android output");
  if (!(androidCredentialCleanup < androidArtifactUpload && androidArtifactUpload < androidSignedCleanup)) {
    failures.push("Android protected job must destroy credentials, upload the internal artifact, then always destroy signed output");
  }
  const androidFinalizer = jobs.get("android-finalize");
  const actualAndroidFinalizerDigest = sha256(androidFinalizer);
  if (actualAndroidFinalizerDigest !== expectedAndroidFinalizerDigest) {
    failures.push(
      `android-finalize execution program changed: expected ${expectedAndroidFinalizerDigest}, got ${actualAndroidFinalizerDigest}`,
    );
  }
  for (const marker of [
    "EXPECTED_IDENTITY: ${{ needs.prepare.outputs.identity }}",
    "EXPECTED_SOURCE_SHA: ${{ needs.prepare.outputs.source_sha }}",
    "EXPECTED_SIGNED_SHA256: ${{ needs.android-sign-upload.outputs.artifact_sha256 }}",
    "(cd signed-android && sha256sum -c CHECKSUMS.sha256)",
    ".identity == $identity and .sourceSha == $source and .signedSha256 == $sha",
    'test "$(sha256sum "signed-android/ZUULI-${EXPECTED_IDENTITY}-android.aab"',
    'cp "signed-android/ZUULI-${EXPECTED_IDENTITY}-android.aab" release-artifacts/',
    "android-signed-universal-aab",
  ]) requireText(failures, "Android finalizer", androidFinalizer, marker);
  const finalizerChecksum = androidFinalizer.indexOf(
    "(cd signed-android && sha256sum -c CHECKSUMS.sha256)",
  );
  const finalizerRecord = androidFinalizer.indexOf(".identity == $identity and .sourceSha == $source and .signedSha256 == $sha");
  const finalizerDigest = androidFinalizer.indexOf(
    'test "$(sha256sum "signed-android/ZUULI-${EXPECTED_IDENTITY}-android.aab"',
  );
  const finalizerCopy = androidFinalizer.indexOf(
    'cp "signed-android/ZUULI-${EXPECTED_IDENTITY}-android.aab" release-artifacts/',
  );
  if (!(finalizerChecksum >= 0 && finalizerChecksum < finalizerRecord && finalizerRecord < finalizerDigest && finalizerDigest < finalizerCopy)) {
    failures.push(
      "Android finalizer must verify the signed checksum, exact source/identity/digest record, and AAB digest before copying the shipped artifact",
    );
  }
  const releaseIndexNode = jobNodes.get("release-index");
  const actualReleaseIndexDigest = sha256(jobs.get("release-index"));
  if (actualReleaseIndexDigest !== expectedReleaseIndexDigest) {
    failures.push(
      `release-index execution program changed: expected ${expectedReleaseIndexDigest}, got ${actualReleaseIndexDigest}`,
    );
  }
  const releaseIndexCondition = pairFor(releaseIndexNode, "if")?.value;
  const actualReleaseIndexCondition = isScalar(releaseIndexCondition) &&
    typeof releaseIndexCondition.value === "string"
    ? releaseIndexCondition.value.replace(/\s+/g, " ").trim()
    : null;
  if (actualReleaseIndexCondition !== RELEASE_INDEX_CONDITION) {
    failures.push("release-index must enforce the exact selected-success/unselected-skipped target matrix");
  }
  requireText(
    failures,
    "Release index target binding",
    jobs.get("release-index"),
    "needs: [prepare, android-build, android-sign-upload, android-finalize, ios-finalize, linux, macos-finalize]",
  );
  if (!exactReleaseIndexJob(releaseIndexNode)) {
    failures.push(
      "release-index must contain exactly the reviewed checkout, artifact download, verifier, draft publisher, and index upload steps plus the reviewed job authority, with no other execution path",
    );
  }

  for (const name of FINALIZE_JOBS) {
    const source = jobs.get(name);
    if (pairFor(jobNodes.get(name), "environment")) failures.push(`${name} contains forbidden protected environment`);
    requireText(failures, name, source, "actions/download-artifact@");
    requireText(failures, name, source, "actions/attest-build-provenance@");
    requireText(failures, name, source, "actions/upload-artifact@");
  }

  rejectText(
    failures,
    "iOS signer",
    jobs.get("ios-sign"),
    "ASC_KEY_BASE64: ${{ secrets.ASC_KEY_BASE64 }}",
  );
  rejectText(
    failures,
    "iOS uploader",
    jobs.get("ios-upload"),
    "APPLE_DISTRIBUTION_CERTIFICATE_BASE64",
  );
  requireText(failures, "iOS signer", jobs.get("ios-sign"), "xcodebuild -exportArchive");
  requireText(
    failures,
    "iOS unsigned builder",
    jobs.get("ios-build"),
    "ZUULI.xcarchive.zip ExportOptions.plist source-record.json > CHECKSUMS.sha256",
  );
  requireText(failures, "iOS signer", jobs.get("ios-sign"), "EXPECTED_PAYLOAD_SHA256");
  requireText(
    failures,
    "iOS signer",
    jobs.get("ios-sign"),
    'test "$(shasum -a 256 unsigned-ios/CHECKSUMS.sha256',
  );
  requireText(
    failures,
    "iOS signer",
    jobs.get("ios-sign"),
    "(cd unsigned-ios && shasum -a 256 -c CHECKSUMS.sha256)",
  );
  requireText(
    failures,
    "iOS signer",
    jobs.get("ios-sign"),
    "gh attestation verify unsigned-ios/CHECKSUMS.sha256",
  );
  requireText(failures, "iOS signer", jobs.get("ios-sign"), "original-keychains.txt");
  requireText(failures, "iOS signer", jobs.get("ios-sign"), "cleanup-failed");
  requireText(
    failures,
    "iOS signer",
    jobs.get("ios-sign"),
    'if [[ -n "$profile_path" ]] && ! rm -f -- "$profile_path"',
  );
  requireText(
    failures,
    "iOS signer",
    jobs.get("ios-sign"),
    'if [[ -e "$HOME/Library/MobileDevice/Provisioning Profiles/e5ead62c-83ec-4e54-abb6-4770833b5e0d.mobileprovision" ]]',
  );
  requireText(
    failures,
    "iOS uploader",
    jobs.get("ios-upload"),
    "gh attestation verify verified-ios/asc-testflight.mjs",
  );
  requireText(failures, "macOS signer", jobs.get("macos-sign"), "codesign");
  requireText(failures, "macOS signer", jobs.get("macos-sign"), "xcrun notarytool submit");
  requireText(
    failures,
    "macOS unsigned builder",
    jobs.get("macos-build"),
    "Entitlements.plist Info.macos.plist ZUULI.app.zip ZUULI-layout.dmg source-record.json > CHECKSUMS.sha256",
  );
  requireText(
    failures,
    "macOS unsigned builder",
    jobs.get("macos-build"),
    "node scripts/macos-keychain-entitlements.mjs",
  );
  requireText(failures, "macOS signer", jobs.get("macos-sign"), "EXPECTED_PAYLOAD_SHA256");
  requireText(
    failures,
    "macOS signer",
    jobs.get("macos-sign"),
    'test "$(shasum -a 256 unsigned-macos/CHECKSUMS.sha256',
  );
  requireText(
    failures,
    "macOS signer",
    jobs.get("macos-sign"),
    "(cd unsigned-macos && shasum -a 256 -c CHECKSUMS.sha256)",
  );
  requireText(
    failures,
    "macOS signer",
    jobs.get("macos-sign"),
    "gh attestation verify unsigned-macos/CHECKSUMS.sha256",
  );
  requireText(failures, "macOS signer", jobs.get("macos-sign"), "original-keychains.txt");
  requireText(failures, "macOS signer", jobs.get("macos-sign"), "cleanup-failed");
  requireText(
    failures,
    "macOS signer",
    jobs.get("macos-sign"),
    "--entitlements unsigned-macos/Entitlements.plist",
  );
  requireText(failures, "macOS signer", jobs.get("macos-sign"), "signed-entitlements.plist");
  requireText(failures, "macOS signer", jobs.get("macos-sign"), '"keychain-access-groups"[0]');
  for (const marker of [
    '"com.apple.security.device.audio-input"',
    '"com.apple.security.device.camera"',
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
    "ZUULI uses the camera when you broadcast or join a live video stream.",
    "ZUULI uses the microphone when you broadcast or join a live stream.",
  ]) {
    requireText(failures, "macOS signer", jobs.get("macos-sign"), marker);
    requireText(failures, "macOS finalizer", jobs.get("macos-finalize"), marker);
  }
  requireText(
    failures,
    "macOS signer",
    jobs.get("macos-sign"),
    "APPLE_DEVELOPER_ID_PROVISIONING_PROFILE_BASE64",
  );
  requireText(failures, "macOS signer", jobs.get("macos-sign"), "embedded.provisionprofile");
  for (const marker of [
    "verify_developer_id_profile()",
    "plutil -extract TeamIdentifier raw -expect array",
    "plutil -extract TeamIdentifier.0 raw -expect string",
    "plutil -extract ProvisionsAllDevices raw -expect bool",
    "plutil -extract 'Entitlements.com\\.apple\\.application-identifier' raw -expect string",
    "plutil -extract Entitlements.keychain-access-groups raw -expect array",
    'plutil -extract "Entitlements.keychain-access-groups.${group_index}" raw -expect string',
    '[[ "$group" == F9AV5HKF6N.cash.free2z.zuuli || "$group" == \'F9AV5HKF6N.*\' ]]',
    "plutil -extract CreationDate raw -expect date",
    "plutil -extract ExpirationDate raw -expect date",
    'date -j -u -f "%Y-%m-%dT%H:%M:%SZ"',
    "created_epoch <= profile_now && profile_now < expiration_epoch",
  ]) {
    requireText(failures, "macOS signer", jobs.get("macos-sign"), marker);
    requireText(failures, "macOS finalizer", jobs.get("macos-finalize"), marker);
  }
  requireText(
    failures,
    "macOS signer",
    jobs.get("macos-sign"),
    'verify_developer_id_profile "$secret_dir/profile.plist" "$profile_now"',
  );
  requireText(
    failures,
    "macOS finalizer",
    jobs.get("macos-finalize"),
    'verify_developer_id_profile "$inspect/profile.plist" "$profile_now"',
  );
  requireText(
    failures,
    "macOS signer",
    jobs.get("macos-sign"),
    'if [[ "$mounted" == true ]] && ! hdiutil detach "$mountpoint" -force',
  );
  requireText(
    failures,
    "macOS signer",
    jobs.get("macos-sign"),
    "if hdiutil info | grep -Fq 'zuuli-macos-dmg-sign.'",
  );

  return failures;
}

async function main() {
  const workflowUrl = new URL("../../../.github/workflows/zuuli-release.yml", import.meta.url);
  const publisherUrl = new URL("./publish-github-release.sh", import.meta.url);
  const failures = [
    ...verifyAppleCredentialBoundary(await readFile(workflowUrl, "utf8")),
    ...verifyGithubReleasePublisher(await readFile(publisherUrl, "utf8")),
  ];
  if (failures.length > 0) {
    console.error("Store-release credential boundary verification failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log("Store-release build, credential, and finalization boundaries verified.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
