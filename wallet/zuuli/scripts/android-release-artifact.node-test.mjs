import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("./android-release-artifact.sh", import.meta.url).pathname;
const canary = new URL("./assert-no-android-credentials.sh", import.meta.url).pathname;

function run(args, options = {}) {
  return spawnSync(script, args, { encoding: "utf8", ...options });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zuuli-android-artifact-test-"));
  const payload = join(root, "payload");
  await Promise.all([
    mkdir(join(payload, "base/lib/arm64-v8a"), { recursive: true }),
    mkdir(join(payload, "base/lib/armeabi-v7a"), { recursive: true }),
    mkdir(join(payload, "base/lib/x86"), { recursive: true }),
    mkdir(join(payload, "base/lib/x86_64"), { recursive: true }),
  ]);
  for (const abi of ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"])
    await writeFile(join(payload, `base/lib/${abi}/libzuuli.so`), abi);
  const aab = join(root, "fixture.aab");
  const zipped = spawnSync("zip", ["-q", "-r", aab, "."], { cwd: payload });
  assert.equal(zipped.status, 0);
  const output = join(root, "record");
  const verifier = join(root, "bundletool.jar");
  await writeFile(verifier, "pinned verifier fixture");
  const verifierSha = spawnSync("sha256sum", [verifier], { encoding: "utf8" }).stdout.split(" ")[0];
  return { root, aab, output, verifier, verifierSha };
}

test("records and verifies a checksum-closed four-ABI AAB", async (t) => {
  const { root, aab, output, verifier, verifierSha } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const recorded = run(["record", aab, "0.1.0+14", "a".repeat(40), "b".repeat(40), output]);
  assert.equal(recorded.status, 0, recorded.stderr);
  const sealed = run(["seal-verifier", output, verifier, verifierSha]);
  assert.equal(sealed.status, 0, sealed.stderr);
  assert.equal(run(["verify", output]).status, 0);
  const source = JSON.parse(await readFile(join(output, "source-record.json"), "utf8"));
  assert.deepEqual(source.abis, ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"]);
  assert.equal(source.verifier.sha256, verifierSha);
});

test("record and seal-verifier print one bare digest and nothing else", async (t) => {
  const { root, aab, output, verifier, verifierSha } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  // $GITHUB_OUTPUT takes one key=value per line, so every extra stdout line
  // from a helper (`sha256sum -c` names each member) breaks the release job.
  const recorded = run(["record", aab, "0.1.0+14", "a".repeat(40), "b".repeat(40), output]);
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.match(recorded.stdout, /^[0-9a-f]{64}\n$/);

  const sealed = run(["seal-verifier", output, verifier, verifierSha]);
  assert.equal(sealed.status, 0, sealed.stderr);
  assert.match(sealed.stdout, /^[0-9a-f]{64}\n$/);
  assert.equal(sealed.stdout.trimEnd().split("\n").length, 1, sealed.stdout);
});

test("seal-verifier still refuses a recorded member that drifted", async (t) => {
  const { root, aab, output, verifier, verifierSha } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(run(["record", aab, "0.1.0+14", "a".repeat(40), "b".repeat(40), output]).status, 0);
  // Silencing the pre-seal checksum check must not disable it.
  await writeFile(join(output, "aab-members.txt"), "drifted\n");
  const sealed = run(["seal-verifier", output, verifier, verifierSha]);
  assert.notEqual(sealed.status, 0);
  assert.match(sealed.stderr, /unsigned artifact is not ready to seal/);
});

test("rejects missing ABIs and checksum drift", async (t) => {
  const { root, aab, output, verifier, verifierSha } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(run(["record", aab, "0.1.0+14", "a".repeat(40), "b".repeat(40), output]).status, 0);
  assert.equal(run(["seal-verifier", output, verifier, verifierSha]).status, 0);
  await writeFile(join(output, "source-record.json"), "{}\n");
  assert.notEqual(run(["verify", output]).status, 0);

  const missing = join(root, "missing");
  await mkdir(missing);
  await writeFile(join(missing, "readme"), "not universal");
  const badAab = join(root, "missing.aab");
  assert.equal(spawnSync("zip", ["-q", badAab, "readme"], { cwd: missing }).status, 0);
  assert.notEqual(run(["record", badAab, "0.1.0+14", "a".repeat(40), "b".repeat(40), join(root, "bad")]).status, 0);
});

test("rejects an unpinned or post-seal mutated verifier", async (t) => {
  const { root, aab, output, verifier, verifierSha } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(run(["record", aab, "0.1.0+14", "a".repeat(40), "b".repeat(40), output]).status, 0);
  assert.notEqual(run(["seal-verifier", output, verifier, "0".repeat(64)]).status, 0);
  assert.equal(run(["seal-verifier", output, verifier, verifierSha]).status, 0);
  await writeFile(join(output, "bundletool-all-1.18.3.jar"), "mutated verifier");
  assert.notEqual(run(["verify", output]).status, 0);
});

test("Android build canary rejects ambient signing and upload authority", async (t) => {
  const runnerTemp = await mkdtemp(join(tmpdir(), "zuuli-android-canary-test-"));
  t.after(() => rm(runnerTemp, { recursive: true, force: true }));
  const clean = spawnSync(canary, [], {
    encoding: "utf8",
    env: { ...process.env, RUNNER_TEMP: runnerTemp },
  });
  assert.equal(clean.status, 0, clean.stderr);
  for (const variable of [
    "ANDROID_KEYSTORE_BASE64",
    "ANDROID_KEYSTORE_PATH",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
    "ANDROID_KEY_PASSWORD",
    "PLAY_SERVICE_ACCOUNT_JSON_BASE64",
    "PLAY_SERVICE_ACCOUNT_JSON",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "ZUULI_CONFIRM_UPLOAD",
  ]) {
    const rejected = spawnSync(canary, [], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: runnerTemp, [variable]: "present" },
    });
    assert.notEqual(rejected.status, 0, `${variable} escaped the build canary`);
  }
});
