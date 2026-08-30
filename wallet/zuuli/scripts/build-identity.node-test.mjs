import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadBuildIdentity } from "./build-identity.mjs";

const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const release = {
  applicationId: "cash.free2z.zuuli",
  version: "1.2.3",
  build: 45,
};
const metadata = { schemaVersion: 1, channel: "internal" };

async function fixture(releaseValue = release, metadataValue = metadata) {
  const root = await mkdtemp(join(tmpdir(), "zuuli-build-identity-"));
  await writeFile(join(root, "release.json"), JSON.stringify(releaseValue));
  await writeFile(join(root, "build-info.json"), JSON.stringify(metadataValue));
  return root;
}

const gitAt = (sha, status = "") => (_command, args) =>
  args[0] === "status" ? status : `${sha}\n`;

test("binds canonical release fields, normalized CI SHA, and build platform", async () => {
  const root = await fixture();
  const identity = loadBuildIdentity({
    root,
    env: {
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: "9".repeat(40),
      ZUULI_RELEASE_SOURCE_SHA: SHA,
      TAURI_ENV_PLATFORM: "darwin",
    },
    git: gitAt(SHA),
  });

  assert.deepEqual(identity, {
    productName: "ZUULI",
    applicationId: "cash.free2z.zuuli",
    version: "1.2.3",
    build: 45,
    channel: "internal",
    platform: "macos",
    sourceCommit: SHA,
  });
  assert.equal(Object.isFrozen(identity), true);
});

test("requires every supplied source SHA to equal the checked-out commit", async () => {
  const root = await fixture();
  for (const env of [
    { ZUULI_RELEASE_SOURCE_SHA: "1".repeat(40) },
    { GITHUB_ACTIONS: "true", GITHUB_SHA: "2".repeat(40) },
    { ZUULI_RELEASE_SOURCE_SHA: "debug" },
    { GITHUB_ACTIONS: "true", GITHUB_SHA: "0".repeat(40) },
  ]) {
    assert.throws(() => loadBuildIdentity({ root, env, git: gitAt(SHA) }));
  }
});

test("fails closed when a declared source cannot be checked against Git", async () => {
  const root = await fixture();
  assert.throws(() =>
    loadBuildIdentity({
      root,
      env: { ZUULI_RELEASE_SOURCE_SHA: SHA },
      git: () => {
        throw new Error("git unavailable");
      },
    }),
  );
});

test("records unavailable source honestly only when no source was declared", async () => {
  const root = await fixture();
  const identity = loadBuildIdentity({
    root,
    env: {},
    git: () => {
      throw new Error("git unavailable");
    },
  });
  assert.equal(identity.sourceCommit, null);
  assert.equal(identity.platform, "web");
});

test("never presents a dirty checkout as the exact source commit", async () => {
  const root = await fixture();
  for (const status of [
    " M src/App.tsx\n",
    "?? local-debug.ts\n",
    " M z/zcash/librustzcash\n",
  ]) {
    const unavailable = loadBuildIdentity({
      root,
      env: {},
      git: gitAt(SHA, status),
    });
    assert.equal(unavailable.sourceCommit, null);
    assert.throws(() =>
      loadBuildIdentity({
        root,
        env: { ZUULI_RELEASE_SOURCE_SHA: SHA },
        git: gitAt(SHA, status),
      }),
    );
  }
});

test("rejects release and platform drift instead of inventing identity", async () => {
  for (const changed of [
    { ...release, applicationId: "example.invalid" },
    { ...release, version: "debug" },
    { ...release, build: 0 },
  ]) {
    const root = await fixture(changed);
    assert.throws(() => loadBuildIdentity({ root, env: {}, git: gitAt(SHA) }));
  }
  const invalidChannelRoot = await fixture(release, {
    ...metadata,
    channel: "nightly",
  });
  assert.throws(() =>
    loadBuildIdentity({
      root: invalidChannelRoot,
      env: {},
      git: gitAt(SHA),
    }),
  );
  const root = await fixture();
  assert.throws(() =>
    loadBuildIdentity({
      root,
      env: { ZUULI_BUILD_PLATFORM: "debug-device" },
      git: gitAt(SHA),
    }),
  );
});
