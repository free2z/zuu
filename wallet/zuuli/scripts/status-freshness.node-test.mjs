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
  verifyStatusFreshness,
} from "./status-freshness.mjs";

const statusPath = "wallet/zuuli/STATUS.md";
const zuuliPath = (path) => `wallet/zuuli/${path}`;

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
  return `# ZUULI product status

Last re-derived from \`origin/main\` at
\`${sha}\` on ${date}. Before a release,
update the evidence honestly.
`;
}

function seedReleaseFiles(fixture) {
  for (const [path, contents] of initialReleaseFiles) {
    fixture.write(zuuliPath(path), contents);
  }
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
  "scripts/check-zcash-permissions.mjs",
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
