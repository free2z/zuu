// Rebuild with the pinned compiler/libraries in package-lock.json. The public MPC
// transcript is authenticated before use; no local ceremony or secret is created.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = "https://circom.info/powersOfTau28_hez_final_12.ptau";
const expected =
  "ded2694169b7b08e898f736d5de95af87c3f1a64594013351b1a796dbee393bd825f88f9468c84505ddd11eb0b1465ac9b43b9064aa8ec97f2b73e04758b8a4a";
const scratch = await mkdtemp(join(tmpdir(), "campaign-proof-build-"));
const transcript = join(scratch, "public-mpc.ptau");
const response = await fetch(source);
if (!response.ok) throw new Error(`MPC download failed: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("blake2b512").update(bytes).digest("hex") !== expected)
  throw new Error("Public MPC transcript BLAKE2b mismatch");
await writeFile(transcript, bytes);
const run = (script, args) =>
  execFileSync(process.execPath, [script, ...args], { stdio: "inherit" });
run("scripts/verify-campaign-mpc.mjs", [transcript]);
run("node_modules/circom2/cli.js", [
  "circuits/campaign-threshold.circom",
  "--r1cs",
  "--wasm",
  "--sym",
  "-o",
  scratch,
]);
const r1cs = join(scratch, "campaign-threshold.r1cs");
const key = join(scratch, "campaign-threshold.zkey");
run("node_modules/snarkjs/build/cli.cjs", [
  "plonk",
  "setup",
  r1cs,
  transcript,
  key,
]);
const output = "static/projects/campaign-demo-proof";
await mkdir(output, { recursive: true });
await copyFile(
  join(scratch, "campaign-threshold_js/campaign-threshold.wasm"),
  join(output, "threshold.wasm"),
);
await copyFile(key, join(output, "threshold.zkey"));
run("node_modules/snarkjs/build/cli.cjs", [
  "zkey",
  "export",
  "verificationkey",
  key,
  join(output, "verification-key.json"),
]);
run("node_modules/prettier/bin/prettier.cjs", [
  "--write",
  join(output, "verification-key.json"),
]);
const files = {};
for (const name of [
  "threshold.wasm",
  "threshold.zkey",
  "verification-key.json",
])
  files[name] = createHash("sha256")
    .update(await readFile(join(output, name)))
    .digest("hex");
await writeFile(
  join(output, "manifest.json"),
  JSON.stringify(
    {
      protocol: "plonk",
      curve: "bn128",
      compiler: "circom 2.2.2 (circom2 0.2.22)",
      snarkjs: "0.7.6",
      circomlib: "2.0.5",
      source,
      powersOfTauBlake2b512: expected,
      mpcVerification:
        "Full snarkjs 0.7.6 source verifier passed (exit 0); native BLAKE2b-512 initial-hash adapter only",
      verifierUtilitySha256:
        "a2cf75004f68ed70fbce610521715150da9e82d68f6aed3fb6f091855cb5098d",
      circuitSha256: createHash("sha256")
        .update(await readFile("circuits/campaign-threshold.circom"))
        .digest("hex"),
      files,
    },
    null,
    2,
  ) + "\n",
);
// Keep the verifier and trusted hashes in the bundle. Importing the /static
// directory directly in development hits the application's Django proxy.
await mkdir("src/lib/campaign/artifacts", { recursive: true });
for (const name of ["verification-key.json", "manifest.json"])
  await copyFile(join(output, name), join("src/lib/campaign/artifacts", name));
console.log(
  `Verified MPC setup and generated fixed assets in ${output}. Scratch: ${scratch}`,
);
