// Materialise the campaign demo's PLONK proving assets (threshold.wasm and
// threshold.zkey, ~11 MB together) at build/test time instead of committing
// them. Both are a deterministic function of public, pinned, committed inputs:
//
//   circuits/campaign-threshold.circom      (SHA-256 pinned in the manifest)
//   circuits/powersOfTau28_hez_final_12.ptau (public Hermez power-12 MPC
//                                            transcript, BLAKE2b-512 pinned)
//   circom2 / circomlib / snarkjs           (exact versions in package-lock.json)
//
// No network access: the transcript is committed, so an outage of its original
// host cannot block a build, a test run or an image build.
//
// The bundled manifest (src/lib/campaign/artifacts/manifest.json) is the trust
// anchor: every input is checked against it before use and every output is
// checked against its SHA-256 before it is installed. A mismatch is a hard
// failure, never a silent rebuild with different keys. Assets that are already
// present and match are left alone.
//
// This does NOT re-run the slow full MPC transcript verification; that is the
// one-time audit performed by `npm run campaign:proof-generate`, which is also
// the only command that may change the manifest. See docs/campaign-proof.md.
//
// CAMPAIGN_PTAU_FILE=<path> overrides the committed transcript (it is
// hash-checked the same way).
//
// Run directly (`npm run campaign:proof-assets`, also part of `prebuild`), or
// import `ensureCampaignProofAssets` — the campaign proof tests do, so only
// they depend on this step.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CAMPAIGN_PROOF_OUTPUT = join(
  root,
  "static/projects/campaign-demo-proof",
);
const COMMITTED_TRANSCRIPT = join(
  root,
  "circuits/powersOfTau28_hez_final_12.ptau",
);
const NAMES = /** @type {const} */ (["threshold.wasm", "threshold.zkey"]);

/** @param {Uint8Array} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** @param {string} path */
async function readIfPresent(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT")
      return undefined;
    throw error;
  }
}

/** @param {{ files: Record<string, string> }} manifest */
async function upToDate(manifest) {
  for (const name of NAMES) {
    const bytes = await readIfPresent(join(CAMPAIGN_PROOF_OUTPUT, name));
    if (!bytes || sha256(bytes) !== manifest.files[name]) return false;
  }
  return true;
}

/**
 * Ensure the proving assets exist and match the bundled manifest.
 * @returns {Promise<"present" | "built">}
 */
export async function ensureCampaignProofAssets() {
  const manifest = JSON.parse(
    await readFile(
      join(root, "src/lib/campaign/artifacts/manifest.json"),
      "utf8",
    ),
  );
  if (await upToDate(manifest)) return "present";

  const circuit = await readFile(
    join(root, "circuits/campaign-threshold.circom"),
  );
  if (sha256(circuit) !== manifest.circuitSha256)
    throw new Error(
      "circuits/campaign-threshold.circom no longer matches the manifest; " +
        "run `npm run campaign:proof-generate` to re-derive and review new keys.",
    );

  const transcript = process.env.CAMPAIGN_PTAU_FILE || COMMITTED_TRANSCRIPT;
  const digest = createHash("blake2b512")
    .update(await readFile(transcript))
    .digest("hex");
  if (digest !== manifest.powersOfTauBlake2b512)
    throw new Error(
      `${transcript}: public MPC transcript BLAKE2b-512 does not match the manifest`,
    );

  const scratch = await mkdtemp(join(tmpdir(), "campaign-proof-assets-"));
  try {
    /** @param {string} script @param {string[]} args */
    const run = (script, args) =>
      execFileSync(process.execPath, [join(root, script), ...args], {
        cwd: root,
        stdio: ["ignore", "ignore", "inherit"],
      });
    run("node_modules/circom2/cli.js", [
      "circuits/campaign-threshold.circom",
      "--r1cs",
      "--wasm",
      "-o",
      scratch,
    ]);
    const key = join(scratch, "campaign-threshold.zkey");
    run("node_modules/snarkjs/build/cli.cjs", [
      "plonk",
      "setup",
      join(scratch, "campaign-threshold.r1cs"),
      transcript,
      key,
    ]);
    const built = {
      "threshold.wasm": await readFile(
        join(scratch, "campaign-threshold_js/campaign-threshold.wasm"),
      ),
      "threshold.zkey": await readFile(key),
    };
    for (const name of NAMES)
      if (sha256(built[name]) !== manifest.files[name])
        throw new Error(
          `Rebuilt ${name} does not match the manifest SHA-256; refusing to install it. ` +
            "Check the circom2/circomlib/snarkjs versions in package-lock.json.",
        );
    await mkdir(CAMPAIGN_PROOF_OUTPUT, { recursive: true });
    for (const name of NAMES) {
      // Unique staging name: concurrent test processes may both build.
      const staged = join(
        CAMPAIGN_PROOF_OUTPUT,
        `.${name}.${process.pid}.${Date.now()}.tmp`,
      );
      await writeFile(staged, built[name]);
      await rename(staged, join(CAMPAIGN_PROOF_OUTPUT, name));
    }
    return "built";
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await ensureCampaignProofAssets();
  console.log(
    result === "present"
      ? "Campaign proof assets are present and match the manifest."
      : `Built and verified campaign proof assets in ${CAMPAIGN_PROOF_OUTPUT}.`,
  );
}
