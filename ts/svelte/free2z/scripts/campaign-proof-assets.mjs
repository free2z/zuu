// Materialise the campaign demo's PLONK proving assets (threshold.wasm and
// threshold.zkey, ~11 MB together) at build/test time instead of committing
// them. Both are a deterministic function of public, pinned inputs:
//
//   circuits/campaign-threshold.circom  (SHA-256 pinned in the manifest)
//   circom2 / circomlib / snarkjs       (exact versions in package-lock.json)
//   the public Hermez power-12 MPC transcript (BLAKE2b-512 pinned)
//
// The bundled manifest (src/lib/campaign/artifacts/manifest.json) is the trust
// anchor: every input is checked against it before use and every output is
// checked against its SHA-256 before it is installed. A mismatch is a hard
// failure, never a silent rebuild with different keys. Assets that are already
// present and match are left alone, so repeat builds/tests make no request.
//
// This does NOT re-run the slow full MPC transcript verification; that is the
// one-time audit performed by `npm run campaign:proof-generate`, which is also
// the only command that may change the manifest. See docs/campaign-proof.md.
//
// CAMPAIGN_PTAU_FILE=<path> uses a local copy of the transcript (still
// hash-checked) for offline builds.
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
const output = join(root, "static/projects/campaign-demo-proof");
const manifest = JSON.parse(
  await readFile(
    join(root, "src/lib/campaign/artifacts/manifest.json"),
    "utf8",
  ),
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

async function upToDate() {
  for (const name of NAMES) {
    const bytes = await readIfPresent(join(output, name));
    if (!bytes || sha256(bytes) !== manifest.files[name]) return false;
  }
  return true;
}

async function transcriptBytes() {
  const local = process.env.CAMPAIGN_PTAU_FILE;
  let bytes;
  if (local) {
    bytes = await readFile(local);
  } else {
    // Bound the whole download so a stalled connection cannot hang a build.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(manifest.source, {
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(
          `Public MPC transcript download failed (${response.status}) from ${manifest.source}. ` +
            "Set CAMPAIGN_PTAU_FILE to a local copy to build offline.",
        );
      bytes = Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }
  const digest = createHash("blake2b512").update(bytes).digest("hex");
  if (digest !== manifest.powersOfTauBlake2b512)
    throw new Error(
      "Public MPC transcript BLAKE2b-512 does not match the manifest",
    );
  return bytes;
}

if (await upToDate()) {
  console.log("Campaign proof assets are present and match the manifest.");
  process.exit(0);
}

const circuit = await readFile(
  join(root, "circuits/campaign-threshold.circom"),
);
if (sha256(circuit) !== manifest.circuitSha256)
  throw new Error(
    "circuits/campaign-threshold.circom no longer matches the manifest; " +
      "run `npm run campaign:proof-generate` to re-derive and review new keys.",
  );

const scratch = await mkdtemp(join(tmpdir(), "campaign-proof-assets-"));
try {
  const transcript = join(scratch, "public-mpc.ptau");
  await writeFile(transcript, await transcriptBytes());
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
  await mkdir(output, { recursive: true });
  for (const name of NAMES) {
    const staged = join(output, `.${name}.${process.pid}.tmp`);
    await writeFile(staged, built[name]);
    await rename(staged, join(output, name));
  }
  console.log(`Built and verified campaign proof assets in ${output}.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
