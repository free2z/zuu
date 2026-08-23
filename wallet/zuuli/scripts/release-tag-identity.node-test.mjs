import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = dirname(fileURLToPath(import.meta.url));
const verify = resolve(scripts, "verify-release-tag.sh");
const publish = resolve(scripts, "publish-github-release.sh");
const verifyIndex = resolve(scripts, "verify-release-index.sh");
const tag = "zuuli-v9.8.7+654";
const identity = "9.8.7+654";

function runIndex(root, releaseIdentity, sha) {
  return spawnSync(verifyIndex, [root, releaseIdentity, sha], { encoding: "utf8" });
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "zuuli-release-tag-test-"));
  const origin = resolve(root, "origin.git");
  const work = resolve(root, "work");
  await mkdir(work);
  git(root, "init", "--bare", origin);
  git(work, "init", "-b", "main");
  git(work, "config", "user.name", "ZUULI test");
  git(work, "config", "user.email", "zuuli-test@example.invalid");
  await writeFile(resolve(work, "release.txt"), "first\n");
  git(work, "add", "release.txt");
  git(work, "commit", "-m", "first");
  const first = git(work, "rev-parse", "HEAD");
  await writeFile(resolve(work, "release.txt"), "second\n");
  git(work, "commit", "-am", "second");
  const second = git(work, "rev-parse", "HEAD");
  git(work, "tag", "-a", tag, first, "-m", "release");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "origin", "main", `refs/tags/${tag}`);
  return { root, origin, work, first, second };
}

test("records the canonical annotated tag object and peeled commit", async () => {
  const { root, work, first } = await fixture();
  const output = resolve(root, "tag-identity.json");
  execFileSync(verify, [tag, first, output], { cwd: work });
  const identity = JSON.parse(await readFile(output, "utf8"));
  assert.equal(identity.tag, tag);
  assert.equal(identity.peeledCommit, first);
  assert.equal(identity.expectedCommit, first);
  assert.match(identity.tagObject, /^[0-9a-f]{40}$/);
  assert.notEqual(identity.tagObject, first);
});

test("rejects a moved tag even when the tag remains annotated", async () => {
  const { root, work, first, second } = await fixture();
  git(work, "tag", "-f", "-a", tag, second, "-m", "retargeted");
  git(work, "push", "--force", "origin", `refs/tags/${tag}`);
  const result = spawnSync(verify, [tag, first, resolve(root, "identity.json")], {
    cwd: work,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not prepared commit/);
});

test("a retarget during release creation leaves the release draft and stops uploads", async () => {
  const { root, origin, work, first, second } = await fixture();
  const bin = resolve(root, "bin");
  const artifacts = resolve(root, "artifacts");
  const state = resolve(root, "release-state");
  await mkdir(bin);
  await mkdir(resolve(artifacts, "linux"), { recursive: true });
  await writeFile(resolve(artifacts, "linux", "artifact.bin"), "artifact\n");
  const fakeGh = resolve(bin, "gh");
  await writeFile(
    fakeGh,
    `#!/usr/bin/env bash\nset -euo pipefail\n` +
      `if [[ "$1 $2" == "release view" ]]; then [[ -f "$TEST_STATE" ]] && { echo true; exit 0; }; exit 1; fi\n` +
      `if [[ "$1 $2" == "release create" ]]; then echo draft > "$TEST_STATE"; git -C "$TEST_WORK" tag -f -a "$TEST_TAG" "$TEST_SECOND" -m moved; git -C "$TEST_WORK" push --force origin "refs/tags/$TEST_TAG" >/dev/null; exit 0; fi\n` +
      `if [[ "$1 $2" == "release upload" ]]; then echo public > "$TEST_STATE"; exit 0; fi\n` +
      `exit 1\n`,
  );
  await chmod(fakeGh, 0o755);

  const result = spawnSync(publish, [tag, "9.8.7+654", first, artifacts], {
    cwd: work,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TEST_STATE: state,
      TEST_WORK: work,
      TEST_TAG: tag,
      TEST_SECOND: second,
      TEST_ORIGIN: origin,
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not prepared commit|identity changed/);
  assert.equal((await readFile(state, "utf8")).trim(), "draft");
});

test("release index accepts only source-bound platform artifacts", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zuuli-release-index-test-"));
  const sha = "a".repeat(40);
  for (const platform of ["android", "linux"]) {
    const directory = resolve(root, `zuuli-${platform}-${identity}-${sha}`);
    await mkdir(directory);
    await writeFile(resolve(directory, "provenance.json"), `${JSON.stringify({ source: { commit: sha } })}\n`);
  }

  execFileSync(verifyIndex, [root, identity, sha]);
});

test("release index rejects a missing artifact root and malformed identity inputs", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "zuuli-release-index-test-"));
  const sha = "a".repeat(40);

  const missingRoot = runIndex(resolve(parent, "missing"), identity, sha);
  assert.notEqual(missingRoot.status, 0);
  assert.match(missingRoot.stderr, /artifact root does not exist/);

  const invalidIdentity = runIndex(parent, "9.8+654", sha);
  assert.notEqual(invalidIdentity.status, 0);
  assert.match(invalidIdentity.stderr, /invalid release identity/);

  const invalidCommit = runIndex(parent, identity, "A".repeat(40));
  assert.notEqual(invalidCommit.status, 0);
  assert.match(invalidCommit.stderr, /full lowercase SHA-1/);
});

test("release index rejects a recursively downloaded prior index", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zuuli-release-index-test-"));
  const sha = "b".repeat(40);
  const platform = resolve(root, `zuuli-android-${identity}-${sha}`);
  const priorIndex = resolve(root, `zuuli-release-index-${identity}-${sha}`);
  await mkdir(platform);
  await mkdir(priorIndex);
  await writeFile(resolve(platform, "provenance.json"), `${JSON.stringify({ source: { commit: sha } })}\n`);
  await writeFile(resolve(priorIndex, "provenance.json"), `${JSON.stringify({ source: { commit: sha } })}\n`);

  const result = runIndex(root, identity, sha);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected release-index entry/);
});

test("release index rejects a non-directory platform entry", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zuuli-release-index-test-"));
  const sha = "c".repeat(40);
  await writeFile(resolve(root, `zuuli-macos-${identity}-${sha}`), "not a directory\n");

  const result = runIndex(root, identity, sha);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a directory/);
});

test("release index requires one top-level provenance per platform", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zuuli-release-index-test-"));
  const sha = "c".repeat(40);
  const platform = resolve(root, `zuuli-ios-${identity}-${sha}`);
  await mkdir(resolve(platform, "nested"), { recursive: true });

  const missing = runIndex(root, identity, sha);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /no top-level provenance/);

  await writeFile(resolve(platform, "provenance.json"), `${JSON.stringify({ source: { commit: sha } })}\n`);
  await writeFile(resolve(platform, "nested", "provenance.json"), `${JSON.stringify({ source: { commit: sha } })}\n`);

  const duplicate = runIndex(root, identity, sha);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /exactly one provenance/);
});

test("release index rejects a single provenance bound to another commit", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zuuli-release-index-test-"));
  const sha = "d".repeat(40);
  const platform = resolve(root, `zuuli-linux-${identity}-${sha}`);
  await mkdir(platform);
  await writeFile(resolve(platform, "provenance.json"), `${JSON.stringify({ source: { commit: "e".repeat(40) } })}\n`);

  const mismatch = runIndex(root, identity, sha);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /not bound to expected commit/);
});

test("release index rejects an empty artifact root", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zuuli-release-index-test-"));
  const result = runIndex(root, identity, "f".repeat(40));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /contains no platform artifacts/);
});
