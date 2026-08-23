#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";

const BUILD_JOBS = ["ios-build", "macos-build"];
const CREDENTIAL_JOBS = ["ios-sign", "ios-upload", "macos-sign"];
const FINALIZE_JOBS = ["ios-verify", "ios-finalize", "macos-finalize"];
const RELEASE_JOBS = [
  "prepare",
  "android",
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
const ALLOWED_JOB_SECRETS = new Map([
  ["android", new Set([
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
  ["ios-sign", "6e63107606388e3862f81e41da65b1fa8bfca1588b5232f9ca4354203536393c"],
  ["ios-upload", "3ed7cb28646aed24a7df2c347b8ad54838f009841fdd52c64ca1002886aae4b2"],
  ["macos-sign", "c1e218197291583ef9c021ed9e32506bf6696f0a1566d5dc6e4e954aa2833dbb"],
]);

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

/**
 * Enforce the source-level Apple release authority boundary.
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
    requireText(failures, name, source, "--no-sign");
    requireText(failures, name, source, "actions/attest-build-provenance@");
    requireText(failures, name, source, "actions/upload-artifact@");
    const canary = "scripts/assert-no-apple-credentials.sh";
    const firstCanary = source.indexOf(canary);
    const dependencyInstall = source.indexOf("npm ci");
    const unsignedBuild = source.indexOf("--no-sign");
    const lastCanary = source.lastIndexOf(canary);
    if (!(firstCanary >= 0 && firstCanary < dependencyInstall)) {
      failures.push(`${name} must run the Apple credential canary before dependency install`);
    }
    if (!(unsignedBuild >= 0 && unsignedBuild < lastCanary)) {
      failures.push(`${name} must run the Apple credential canary after the unsigned build`);
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
    const lastDestroy = Math.max(
      source.lastIndexOf("Destroy ephemeral"),
      source.lastIndexOf("Destroy all ephemeral"),
    );
    const upload = source.lastIndexOf("actions/upload-artifact@");
    if (!(lastSecret < lastDestroy && lastDestroy < upload)) {
      failures.push(`${name} must destroy every credential class before artifact upload`);
    }
    requireText(failures, name, source, "if: always()");
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
    "Entitlements.plist ZUULI.app.zip ZUULI-layout.dmg source-record.json > CHECKSUMS.sha256",
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
  const failures = verifyAppleCredentialBoundary(await readFile(workflowUrl, "utf8"));
  if (failures.length > 0) {
    console.error("Apple credential boundary verification failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log("Apple release build, credential, and finalization boundaries verified.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
