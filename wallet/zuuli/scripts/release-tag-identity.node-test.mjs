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
const tag = "zuuli-v9.8.7+654";

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
