import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  buildReleaseBumpContents,
  releaseBumpRelativePaths,
} from "./release-bump-content.mjs";
import {
  isReleaseImpactingPath,
  parseStatusMarker,
  releaseBumpPaths,
  verifyReleaseEvidencePolicy,
  verifyStatusFreshness,
} from "./status-freshness.mjs";

const statusPath = "wallet/zuuli/STATUS.md";
const releasingPath = "wallet/zuuli/docs/releasing.md";
const zuuliPath = (path) => `wallet/zuuli/${path}`;
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const releaseEvidencePolicyFixture = readFileSync(
  resolve(repositoryRoot, releasingPath),
  "utf8",
);
const repositoryStatus = readFileSync(resolve(repositoryRoot, statusPath), "utf8");
const repositoryStatusMarkerPattern =
  /^Last re-derived from `origin\/main` at\n`[0-9a-f]{40}` on \d{4}-\d{2}-\d{2}\. Before a release,\nupdate the evidence and disposition for every non-ready row; do not carry this\ncommit or date forward mechanically\.$/m;
assert.match(repositoryStatus, repositoryStatusMarkerPattern);

const initialReleaseFiles = new Map([
  [
    "release.json",
    `${JSON.stringify({ version: "0.1.0", build: 1, channel: "stable" }, null, 2)}\n`,
  ],
  [
    "package.json",
    `${JSON.stringify(
      { name: "zuuli", version: "0.1.0", dependencies: { keep: "1.0.0" } },
      null,
      2,
    )}\n`,
  ],
  [
    "package-lock.json",
    `${JSON.stringify(
      {
        name: "zuuli",
        version: "0.1.0",
        lockfileVersion: 3,
        packages: { "": { version: "0.1.0", dependencies: { keep: "1.0.0" } } },
      },
      null,
      2,
    )}\n`,
  ],
  [
    "src-tauri/Cargo.toml",
    '[package]\nname = "zuuli"\nversion = "0.1.0"\n\n[dependencies]\nkeep = "1"\n',
  ],
  [
    "src-tauri/Cargo.lock",
    '[[package]]\nname = "zuuli"\nversion = "0.1.0"\n\n[[package]]\nname = "keep"\nversion = "1.0.0"\n',
  ],
  [
    "src-tauri/tauri.conf.json",
    '{\n  "version": "0.1.0",\n  "bundle": {\n    "iOS": { "bundleVersion": "1" },\n    "android": { "versionCode": 1 }\n  },\n  "keep": true\n}\n',
  ],
  [
    "src-tauri/gen/apple/project.yml",
    'settings:\n  CFBundleShortVersionString: 0.1.0\n  CFBundleVersion: "1"\n  KEEP: true\n',
  ],
  [
    "src-tauri/gen/apple/zuuli_iOS/Info.plist",
    '<?xml version="1.0"?>\n<plist><dict>\n<key>CFBundleShortVersionString</key><string>0.1.0</string>\n<key>CFBundleVersion</key><string>1</string>\n<key>Keep</key><true/>\n</dict></plist>\n',
  ],
  [
    "src-tauri/gen/android/app/build.gradle.kts",
    'val versionCode = project.findProperty("tauri.android.versionCode", "1")\nval versionName = project.findProperty("tauri.android.versionName", "0.1.0")\nval keep = true\n',
  ],
]);

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function createRepository(t) {
  const root = mkdtempSync(resolve(tmpdir(), "zuuli-status-freshness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "ZUULI status test"]);
  git(root, ["config", "user.email", "zuuli-status-test@example.invalid"]);
  git(root, ["config", "commit.gpgsign", "false"]);

  const write = (path, contents) => {
    const absolute = resolve(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  };
  const commit = (message) => {
    git(root, ["add", "--all"]);
    git(root, ["commit", "--quiet", "--message", message]);
    return git(root, ["rev-parse", "HEAD"]);
  };
  return { root, write, commit };
}

function marker(sha, date = "2026-08-23") {
  return repositoryStatus.replace(
    repositoryStatusMarkerPattern,
    `Last re-derived from \`origin/main\` at
\`${sha}\` on ${date}. Before a release,
update the evidence and disposition for every non-ready row; do not carry this
commit or date forward mechanically.`,
  );
}

function seedReleaseFiles(fixture) {
  for (const [path, contents] of initialReleaseFiles) {
    fixture.write(zuuliPath(path), contents);
  }
  fixture.write(releasingPath, releaseEvidencePolicyFixture);
}

function createAuditedHistory(t) {
  const fixture = createRepository(t);
  fixture.write(statusPath, "# status before re-derivation\n");
  seedReleaseFiles(fixture);
  const auditSha = fixture.commit("candidate source");
  fixture.write(statusPath, marker(auditSha));
  fixture.commit("re-derive status");
  return { ...fixture, auditSha };
}

function commitRelease(fixture, extraChanges = new Map()) {
  const replacements = buildReleaseBumpContents({
    read: (path) =>
      readFileSync(resolve(fixture.root, zuuliPath(path)), "utf8"),
    version: "0.2.0",
    build: 2,
  });
  for (const [path, contents] of replacements) {
    fixture.write(zuuliPath(path), contents);
  }
  for (const [path, contents] of extraChanges) fixture.write(path, contents);
  return fixture.commit("release identity");
}

function tamperReleaseFile(path, contents) {
  if (["release.json", "package.json", "package-lock.json"].includes(path)) {
    const value = JSON.parse(contents);
    if (path === "release.json") value.unrelatedReleaseSetting = true;
    else if (path === "package.json") value.dependencies.injected = "9.9.9";
    else value.packages[""].dependencies.injected = "9.9.9";
    return `${JSON.stringify(value, null, 2)}\n`;
  }
  if (path === "src-tauri/Cargo.toml") return `${contents}injected = "9.9.9"\n`;
  if (path === "src-tauri/Cargo.lock") {
    return `${contents}\n[[package]]\nname = "injected"\nversion = "9.9.9"\n`;
  }
  if (path === "src-tauri/tauri.conf.json") {
    const value = JSON.parse(contents);
    value.plugins = { injected: true };
    return `${JSON.stringify(value, null, 2)}\n`;
  }
  if (path === "src-tauri/gen/apple/project.yml") {
    return `${contents}  INJECTED: true\n`;
  }
  if (path === "src-tauri/gen/apple/zuuli_iOS/Info.plist") {
    return contents.replace("</dict>", "<key>Injected</key><true/>\n</dict>");
  }
  if (path === "src-tauri/gen/android/app/build.gradle.kts") {
    return `${contents}val injected = true\n`;
  }
  throw new Error(`missing semantic tamper fixture for ${path}`);
}

test("parses exactly one strict source marker", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(parseStatusMarker(marker(sha)), {
    auditSha: sha,
    auditDate: "2026-08-23",
  });
});

test("repository records the pre-merge release evidence policy and desktop disposition", () => {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  assert.doesNotThrow(() =>
    verifyReleaseEvidencePolicy({
      releasingContents: readFileSync(resolve(repoRoot, releasingPath), "utf8"),
      statusContents: readFileSync(resolve(repoRoot, statusPath), "utf8"),
    }),
  );
});

for (const [name, mutateDocs, mutateStatus] of [
  [
    "advisory pre-merge wording",
    (contents) => contents.replace("must be backed", "should be backed"),
    (contents) => contents,
  ],
  [
    "non-exclusive evidence requirement",
    (contents) => contents.replace("at least one", "exactly one"),
    (contents) => contents,
  ],
  [
    "fixture without a corrupted-input control",
    (contents) =>
      contents.replace(
        "and is proven to reject a deliberately corrupted input",
        "and covers its expected input",
      ),
    (contents) => contents,
  ],
  [
    "desktop shipping decision",
    (contents) => contents,
    (contents) =>
      contents.replace(
        /desktop distribution is\s+deferred and is not currently shipped/,
        "desktop distribution may be considered later",
      ),
  ],
  [
    "protected macOS execution boundary",
    (contents) => contents,
    (contents) =>
      contents.replace(
        "`packaging-executed-protected-unexecuted`",
        "`protected-executed`",
      ),
  ],
  [
    "release evidence ID",
    (contents) => contents,
    (contents) => contents.replace("`android-protected-sign-upload`", "`renamed-evidence`"),
  ],
  [
    "release evidence path cell",
    (contents) => contents,
    (contents) => contents.replace(
      "Android signed payload comparison, `signed_abis`, `signing-record.json`, `CHECKSUMS`, and Play upload",
      "Android release work",
    ),
  ],
  [
    "release evidence distribution cell",
    (contents) => contents,
    (contents) => contents.replace("`mobile-shipped`", "`desktop-deferred`"),
  ],
  [
    "release execution evidence cell",
    (contents) => contents,
    (contents) => contents.replace("succeeded for [build 17]", "failed for [build 17]"),
  ],
  [
    "noncanonical execution evidence URL",
    (contents) => contents,
    (contents) => contents.replace(
      "https://github.com/free2z/zuu/actions/runs/33330274664/job/99310600158",
      "https://example.invalid/actions/runs/33330274664/job/99310600158",
    ),
  ],
  [
    "deleted six-row evidence inventory",
    (contents) => contents,
    (contents) => contents.replace(/\n\| Evidence ID[\s\S]*$/, "\n"),
  ],
  [
    "contradictory advisory prose",
    (contents) => contents,
    (contents) => contents.replace(
      "\n| Evidence ID",
      "\nDesktop distribution is shipped and protected macOS is covered by packaging smoke.\n\n| Evidence ID",
    ),
  ],
  [
    "advisory policy allowing evidence-free merges",
    (contents) => `${contents}\nThis runbook is guidance only and steps need no supporting evidence.\n`,
    (contents) => contents,
  ],
  [
    "false protected desktop readiness claim",
    (contents) => contents,
    (contents) => `${contents}\n## Later note\nProtected macOS and desktop release jobs are green and production-ready.\n`,
  ],
  [
    "permanent-download claim",
    (contents) => contents,
    (contents) => `${contents}\n## Later note\nRelease artifacts provide permanent downloads.\n`,
  ],
  [
    "greenwashed macOS remaining boundary",
    (contents) => contents,
    (contents) => contents.replace(
      "Protected macOS system signing, notarization, and credential cleanup remain deliberately unexecuted while desktop shipping is deferred.",
      "Protected macOS system signing, notarization, and credential cleanup all executed; production-ready.",
      ),
  ],
  [
    "evidence policy hidden in an HTML comment",
    (contents) => contents
      .replace(
        "## Pre-merge execution evidence for release steps\n",
        "<!--\n## Pre-merge execution evidence for release steps\n",
      )
      .replace(
        "\n## SBOM scope and artifact binding",
        "\n-->\n## SBOM scope and artifact binding",
      ),
    (contents) => contents,
  ],
  [
    "evidence policy hidden in a fenced block",
    (contents) => contents
      .replace(
        "## Pre-merge execution evidence for release steps\n",
        "```text\n## Pre-merge execution evidence for release steps\n",
      )
      .replace(
        "\n## SBOM scope and artifact binding",
        "\n```\n## SBOM scope and artifact binding",
      ),
    (contents) => contents,
  ],
  [
    "release disposition hidden in an HTML container",
    (contents) => contents,
    (contents) => contents
      .replace(
        "## Release-path execution disposition\n",
        "<details>\n## Release-path execution disposition\n",
      )
      .replace(
        "\n## Source-and-runtime-backed matrix",
        "\n</details>\n## Source-and-runtime-backed matrix",
      ),
  ],
  [
    "evidence policy hidden in an HTML container",
    (contents) => contents
      .replace(
        "## Pre-merge execution evidence for release steps\n",
        "<details>\n## Pre-merge execution evidence for release steps\n",
      )
      .replace(
        "\n## SBOM scope and artifact binding",
        "\n</details>\n## SBOM scope and artifact binding",
      ),
    (contents) => contents,
  ],
  [
    "release disposition hidden in an HTML comment",
    (contents) => contents,
    (contents) => contents
      .replace(
        "## Release-path execution disposition\n",
        "<!--\n## Release-path execution disposition\n",
      )
      .replace(
        "\n## Source-and-runtime-backed matrix",
        "\n-->\n## Source-and-runtime-backed matrix",
      ),
  ],
  [
    "release disposition hidden in a fenced block",
    (contents) => contents,
    (contents) => contents
      .replace(
        "## Release-path execution disposition\n",
        "```text\n## Release-path execution disposition\n",
      )
      .replace(
        "\n## Source-and-runtime-backed matrix",
        "\n```\n## Source-and-runtime-backed matrix",
      ),
  ],
  [
    "broad suggestion allowing evidence-free landing",
    (contents) => `${contents}\nThe evidence requirements are merely suggestions; a release change can land when none are met.\n`,
    (contents) => contents,
  ],
  [
    "informational gate allowing approval without artifacts",
    (contents) => `${contents}\nThis release gate is informational; maintainers can approve changes without artifacts.\n`,
    (contents) => contents,
  ],
  [
    "broad protected-desktop production claim",
    (contents) => contents,
    (contents) => `${contents}\n## Later claim\n\nAll protected desktop paths passed and are good for production.\n`,
  ],
  [
    "protected macOS approval claim",
    (contents) => contents,
    (contents) => `${contents}\nProtected macOS is approved to ship despite having no run evidence.\n`,
  ],
  [
    "maintainer waiver claim outside the protected section",
    (contents) => `${contents}\nMaintainers may waive the proof gate for urgent workflow changes.\n`,
    (contents) => contents,
  ],
  [
    "customer rollout claim outside the protected section",
    (contents) => contents,
    (contents) => `${contents}\nThe notarized computer installers are cleared for customer rollout.\n`,
  ],
]) {
  test(`rejects a weakened ${name}`, () => {
    const statusContents = marker("a".repeat(40));
    assert.throws(
      () =>
        verifyReleaseEvidencePolicy({
          releasingContents: mutateDocs(releaseEvidencePolicyFixture),
          statusContents: mutateStatus(statusContents),
        }),
      /release-step evidence policy is incomplete/,
    );
  });
}

function wrapReleasingEvidence(open, close) {
  return releaseEvidencePolicyFixture
    .replace(
      "## Pre-merge execution evidence for release steps\n",
      `${open}\n## Pre-merge execution evidence for release steps\n`,
    )
    .replace(
      "## SBOM scope and artifact binding\n",
      `## SBOM scope and artifact binding\n${close}\n`,
    );
}

function wrapStatusEvidence(contents, open, close) {
  return contents
    .replace("## Evidence boundaries\n", `${open}\n## Evidence boundaries\n`)
    .replace(
      "## Source-and-runtime-backed matrix\n",
      `## Source-and-runtime-backed matrix\n${close}\n`,
    );
}

function assertEvidenceMutationRejected(name, mutateDocs, mutateStatus) {
  test(`rejects CommonMark/policy bypass: ${name}`, () => {
    assert.throws(
      () => verifyReleaseEvidencePolicy({
        releasingContents: mutateDocs(releaseEvidencePolicyFixture),
        statusContents: mutateStatus(marker("a".repeat(40))),
      }),
      /release-step evidence policy is incomplete/,
    );
  });
}

for (const spaces of [1, 2, 3]) {
  const heading = `${" ".repeat(spaces)}## Unrelated rendered section\n\n`;
  assertEvidenceMutationRejected(
    `${spaces}-space ATX boundary before releasing policy`,
    (contents) => `${heading}${contents}`,
    (contents) => contents,
  );
  assertEvidenceMutationRejected(
    `${spaces}-space ATX boundary before STATUS disposition`,
    (contents) => contents,
    (contents) => contents.replace(
      "## Release-path execution disposition\n",
      `${heading}## Release-path execution disposition\n`,
    ),
  );
}

for (const [name, heading] of [
  ["empty ATX", "##\n\n"],
  ["Setext H2", "Unrelated rendered section\n--------------------------\n\n"],
]) {
  assertEvidenceMutationRejected(
    `${name} boundary before releasing policy`,
    (contents) => `${heading}${contents}`,
    (contents) => contents,
  );
  assertEvidenceMutationRejected(
    `${name} boundary before STATUS disposition`,
    (contents) => contents,
    (contents) => contents.replace(
      "## Release-path execution disposition\n",
      `${heading}## Release-path execution disposition\n`,
    ),
  );
}

for (const [name, open, close] of [
  ["details with quoted greater-than attribute", '<details title="a > b">', "</details>"],
  ["three-space details with quoted self-close text", '   <details title="/>">', "   </details>"],
  ["textarea raw block", "<textarea>", "</textarea>"],
  ["address raw block", "<address>", "</address>"],
  ["processing-instruction raw block", "<?review", "?>"],
  ["declaration raw block", "<!REVIEW", ">"],
  ["CDATA raw block", "<![CDATA[", "]]>"],
]) {
  assertEvidenceMutationRejected(
    `${name} hiding releasing policy`,
    () => wrapReleasingEvidence(open, close),
    (contents) => contents,
  );
  assertEvidenceMutationRejected(
    `${name} hiding STATUS disposition`,
    (contents) => contents,
    (contents) => wrapStatusEvidence(contents, open, close),
  );
}

for (const [name, open, close] of [
  ["quoted greater-than", '<details title="a > b">', "</details>"],
  ["quoted self-close text", '   <details title="/>">', "   </details>"],
]) {
  test(`browser HTML stack hides ${name} releasing headings across blank lines`, () => {
    assert.throws(
      () => verifyReleaseEvidencePolicy({
        releasingContents: wrapReleasingEvidence(open, close),
        statusContents: marker("a".repeat(40)),
      }),
      /found 0 rendered/,
    );
  });
  test(`browser HTML stack hides ${name} STATUS headings across blank lines`, () => {
    assert.throws(
      () => verifyReleaseEvidencePolicy({
        releasingContents: releaseEvidencePolicyFixture,
        statusContents: wrapStatusEvidence(marker("a".repeat(40)), open, close),
      }),
      /found 0 rendered/,
    );
  });
}

assertEvidenceMutationRejected(
  "unreviewed backtick-bearing non-fence line",
  (contents) => "```invalid`info\n" + contents,
  (contents) => contents.replace(
    "## Release-path execution disposition\n",
    "```invalid`info\n## Release-path execution disposition\n",
  ),
);

assertEvidenceMutationRejected(
  "malformed spaced HTML close cannot reveal releasing policy",
  () => wrapReleasingEvidence('<details title="reviewed">', "</ details>"),
  (contents) => contents,
);
assertEvidenceMutationRejected(
  "malformed spaced HTML close cannot reveal STATUS disposition",
  (contents) => contents,
  (contents) => wrapStatusEvidence(contents, '<details title="reviewed">', "</ details>"),
);

for (const [name, open, falseClose, close] of [
  ["short backtick closer", "````text", "```", "````"],
  ["mismatched tilde closer", "````text", "~~~~", "````"],
  ["backtick closer with info", "````text", "```` still-code", "````"],
]) {
  assertEvidenceMutationRejected(
    `${name} hiding releasing policy`,
    () => wrapReleasingEvidence(`${open}\n${falseClose}`, close),
    (contents) => contents,
  );
  assertEvidenceMutationRejected(
    `${name} hiding STATUS disposition`,
    (contents) => contents,
    (contents) => wrapStatusEvidence(contents, `${open}\n${falseClose}`, close),
  );
}

for (const [name, mutateDocs, mutateStatus] of [
  [
    "visible evidence-free runbook bullet",
    (contents) => `${contents}\n- A release-step change can merge before any proof exists when a reviewer accepts the risk.\n`,
    (contents) => contents,
  ],
  [
    "visible evidence-free runbook table",
    (contents) => `${contents}\n| Exception | Disposition |\n| --- | --- |\n| Release-step change | May land before supporting proof exists |\n`,
    (contents) => contents,
  ],
  [
    "visible desktop-shipping STATUS bullet",
    (contents) => contents,
    (contents) => `${contents}\n- Desktop distribution can ship now.\n`,
  ],
  [
    "visible production-ready STATUS table",
    (contents) => contents,
    (contents) => `${contents}\n| Target | Current disposition |\n| --- | --- |\n| macOS release signing | Fully validated for production |\n`,
  ],
  [
    "duplicate contradictory STATUS evidence table",
    (contents) => contents,
    (contents) => `${contents}\n| Evidence ID | New conclusion |\n| --- | --- |\n| macos-packaging | Desktop may ship now |\n`,
  ],
]) {
  assertEvidenceMutationRejected(name, mutateDocs, mutateStatus);
}

function mutateEvidenceCell(contents, id, cellIndex) {
  return contents
    .split("\n")
    .map((line) => {
      if (!line.startsWith(`| \`${id}\` |`)) return line;
      const cells = line.slice(1, -1).split("|");
      assert.equal(cells.length, 6, `${id} fixture row must have six cells`);
      cells[cellIndex] = " adversarial replacement ";
      return `|${cells.join("|")}|`;
    })
    .join("\n");
}

for (const id of [
  "android-protected-sign-upload",
  "android-credential-cleanup",
  "android-finalization",
  "release-index",
  "linux-packaging",
  "macos-packaging",
]) {
  for (const [cell, cellIndex] of [["execution", 4], ["boundary", 5]]) {
    test(`rejects a noncanonical ${id} ${cell} cell`, () => {
      assert.throws(
        () => verifyReleaseEvidencePolicy({
          releasingContents: releaseEvidencePolicyFixture,
          statusContents: mutateEvidenceCell(marker("a".repeat(40)), id, cellIndex),
        }),
        /release-step evidence policy is incomplete/,
      );
    });
  }
}

for (const [name, contents, message] of [
  ["missing marker", "# status\n", "exactly one"],
  [
    "duplicate marker",
    `${marker("a".repeat(40))}\n${marker("b".repeat(40))}`,
    "exactly one",
  ],
  ["short SHA", marker("a".repeat(39)), "full lowercase"],
  ["uppercase SHA", marker("A".repeat(40)), "full lowercase"],
  ["invalid date", marker("a".repeat(40), "2026-02-30"), "real calendar"],
]) {
  test(`rejects a ${name}`, () => {
    assert.throws(() => parseStatusMarker(contents), new RegExp(message));
  });
}

test("accepts a status-only re-derivation, unrelated merge, and release bump", (t) => {
  const fixture = createAuditedHistory(t);
  git(fixture.root, ["switch", "--quiet", "--create", "unrelated-side"]);
  fixture.write("docs/unrelated.md", "unrelated trunk work\n");
  fixture.commit("unrelated side change");
  git(fixture.root, ["switch", "--quiet", "main"]);
  fixture.write("docs/main.md", "advance first parent\n");
  fixture.commit("unrelated main change");
  git(fixture.root, [
    "merge",
    "--quiet",
    "--no-ff",
    "unrelated-side",
    "--message",
    "unrelated merge",
  ]);
  const sourceSha = commitRelease(fixture);

  assert.deepEqual(
    verifyStatusFreshness({ repoRoot: fixture.root, sourceSha }),
    {
      sourceSha,
      parentSha: git(fixture.root, ["rev-parse", `${sourceSha}^1`]),
      auditSha: fixture.auditSha,
      auditDate: "2026-08-23",
    },
  );
});

test("accepts exactly the release-bump-owned source paths", (t) => {
  const fixture = createAuditedHistory(t);
  const sourceSha = commitRelease(fixture);
  assert.deepEqual(
    git(fixture.root, ["diff", "--name-only", `${sourceSha}^`, sourceSha])
      .split("\n")
      .sort(),
    [...releaseBumpPaths].sort(),
  );
  assert.doesNotThrow(() =>
    verifyStatusFreshness({ repoRoot: fixture.root, sourceSha }),
  );
});

for (const relativePath of releaseBumpRelativePaths) {
  test(`rejects non-mechanical release-file change to ${relativePath}`, (t) => {
    const fixture = createAuditedHistory(t);
    const replacements = buildReleaseBumpContents({
      read: (path) =>
        readFileSync(resolve(fixture.root, zuuliPath(path)), "utf8"),
      version: "0.2.0",
      build: 2,
    });
    const tampered = tamperReleaseFile(
      relativePath,
      replacements.get(relativePath),
    );
    const sourceSha = commitRelease(
      fixture,
      new Map([[zuuliPath(relativePath), tampered]]),
    );
    assert.throws(
      () => verifyStatusFreshness({ repoRoot: fixture.root, sourceSha }),
      /non-mechanical changes in release-bump files/,
    );
  });
}

test("rejects a release-impacting change introduced through a second parent", (t) => {
  const fixture = createAuditedHistory(t);
  git(fixture.root, ["switch", "--quiet", "--create", "impacting-side"]);
  fixture.write("wallet/zuuli/src/App.tsx", "changed on side branch\n");
  fixture.commit("impacting side change");
  git(fixture.root, ["switch", "--quiet", "main"]);
  fixture.write("docs/main.md", "advance first parent\n");
  fixture.commit("unrelated main change");
  git(fixture.root, [
    "merge",
    "--quiet",
    "--no-ff",
    "impacting-side",
    "--message",
    "impacting merge",
  ]);
  const sourceSha = commitRelease(fixture);
  assert.throws(
    () => verifyStatusFreshness({ repoRoot: fixture.root, sourceSha }),
    /was not re-derived after release-impacting changes/,
  );
});

for (const path of [
  "wallet/zuuli/src/App.tsx",
  "wallet/plugins/tauri-plugin-zcash/src/lib.rs",
  ".github/workflows/zuuli-release.yml",
  ".github/containers/zuuli-linux/Dockerfile",
  "scripts/check-tauri-plugin-permissions.mjs",
  "z/zcash/librustzcash",
]) {
  test(`rejects intervening release-impacting change to ${path}`, (t) => {
    const fixture = createAuditedHistory(t);
    fixture.write(path, "changed after audit\n");
    fixture.commit("release-impacting change");
    const sourceSha = commitRelease(fixture);
    assert.throws(
      () => verifyStatusFreshness({ repoRoot: fixture.root, sourceSha }),
      /was not re-derived after release-impacting changes/,
    );
  });
}

test("rejects a non-ceremony application change in the release commit", (t) => {
  const fixture = createAuditedHistory(t);
  const sourceSha = commitRelease(
    fixture,
    new Map([["wallet/zuuli/src/App.tsx", "changed in release\n"]]),
  );
  assert.throws(
    () => verifyStatusFreshness({ repoRoot: fixture.root, sourceSha }),
    /release source contains non-ceremony release-impacting changes/,
  );
});

test("rejects a source after rather than at the release identity commit", (t) => {
  const fixture = createAuditedHistory(t);
  fixture.write("docs/unrelated.md", "not the identity commit\n");
  const sourceSha = fixture.commit("commit after release identity");
  assert.throws(
    () => verifyStatusFreshness({ repoRoot: fixture.root, sourceSha }),
    /must be the commit that changes wallet\/zuuli\/release.json/,
  );
});

test("rejects a missing recorded audit commit", (t) => {
  const fixture = createAuditedHistory(t);
  fixture.write(statusPath, marker("f".repeat(40)));
  fixture.commit("record unavailable source");
  const sourceSha = commitRelease(fixture);
  assert.throws(
    () => verifyStatusFreshness({ repoRoot: fixture.root, sourceSha }),
    /recorded STATUS.md audit source is not an available commit/,
  );
});

test("rejects an audit commit reachable only through a second parent", (t) => {
  const fixture = createRepository(t);
  fixture.write(statusPath, "# initial status\n");
  seedReleaseFiles(fixture);
  const baseSha = fixture.commit("base");

  git(fixture.root, ["switch", "--quiet", "--create", "side"]);
  fixture.write("docs/side.md", "side branch\n");
  const sideSha = fixture.commit("side source");

  git(fixture.root, ["switch", "--quiet", "main"]);
  fixture.write(statusPath, marker(sideSha));
  fixture.commit("record side source");
  git(fixture.root, [
    "merge",
    "--quiet",
    "--no-ff",
    "side",
    "--message",
    "merge side",
  ]);
  assert.equal(git(fixture.root, ["merge-base", baseSha, "HEAD"]), baseSha);
  const sourceSha = commitRelease(fixture);

  assert.throws(
    () => verifyStatusFreshness({ repoRoot: fixture.root, sourceSha }),
    /not on the release parent's first-parent history/,
  );
});

test("rejects a release source with multiple parents", (t) => {
  const fixture = createAuditedHistory(t);
  git(fixture.root, ["switch", "--quiet", "--create", "release-side"]);
  fixture.write("wallet/zuuli/release.json", '{"build":2}\n');
  fixture.commit("release side");
  git(fixture.root, ["switch", "--quiet", "main"]);
  fixture.write("docs/main.md", "advance main\n");
  fixture.commit("advance main");
  git(fixture.root, [
    "merge",
    "--quiet",
    "--no-ff",
    "release-side",
    "--message",
    "merge release",
  ]);
  const sourceSha = git(fixture.root, ["rev-parse", "HEAD"]);
  assert.throws(
    () => verifyStatusFreshness({ repoRoot: fixture.root, sourceSha }),
    /release source must have exactly one parent/,
  );
});

test("rejects invalid UTF-8 in source STATUS.md", (t) => {
  const fixture = createAuditedHistory(t);
  const absolute = resolve(fixture.root, statusPath);
  const valid = readFileSync(absolute);
  writeFileSync(absolute, Buffer.concat([valid, Buffer.from([0xff])]));
  fixture.commit("invalid status encoding");
  const sourceSha = commitRelease(fixture);
  assert.throws(
    () => verifyStatusFreshness({ repoRoot: fixture.root, sourceSha }),
    /must contain valid UTF-8/,
  );
});

test("release-impacting selector retains the gate's boundary classes", () => {
  for (const path of [
    "wallet/zuuli/src/App.tsx",
    "wallet/plugins/example/src/lib.rs",
    "wallet/rust-toolchain.toml",
    ".github/workflows/zuuli.yml",
    ".github/actions/zuuli-rust-cache/action.yml",
    "docs/ZUULI-LINUX-BUILD-IMAGE.md",
  ]) {
    assert.equal(isReleaseImpactingPath(path), true, path);
  }
  assert.equal(isReleaseImpactingPath("docs/unrelated.md"), false);
});
