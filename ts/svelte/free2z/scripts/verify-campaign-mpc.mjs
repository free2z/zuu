// Full upstream snarkjs 0.7.6 verification, with ONLY the initial repeated-data
// hash accelerated by Node's native implementation of the SAME BLAKE2b-512.
// The original ceremony can have power 28 even for a truncated power-12 file.
// JS hashing of that ~96 GiB is unnecessarily slow. No ceremony/pairing check
// is removed. Upstream installed files are never edited.
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { curves } from "snarkjs";

const transcript = process.argv[2];
if (!transcript) throw new Error("Pass the authenticated public .ptau path");
const packagePath = resolve("node_modules/snarkjs");
const pkg = JSON.parse(
  await readFile(join(packagePath, "package.json"), "utf8"),
);
if (pkg.version !== "0.7.6")
  throw new Error("Native hash adaptation is pinned to snarkjs 0.7.6");
const snapshot = await mkdtemp(resolve("node_modules/.campaign-mpc-verifier-"));
const relativeUtility = "src/powersoftau_utils.js";
const original = await readFile(join(packagePath, relativeUtility), "utf8");
if (
  createHash("sha256").update(original).digest("hex") !==
  "a2cf75004f68ed70fbce610521715150da9e82d68f6aed3fb6f091855cb5098d"
)
  throw new Error(
    "Upstream snarkjs utility does not match the pinned source hash",
  );
const start = original.indexOf(
  "export function calculateFirstChallengeHash(curve, power, logger) {",
);
const end = original.indexOf("export async function keyFromBeacon", start);
const oldLine = "const hasher = blake2b.create({ dkLen: 64 });";
if (
  start < 0 ||
  end < 0 ||
  original.slice(start, end).split(oldLine).length !== 2
)
  throw new Error("Upstream initial hash function changed; refuse adaptation");
try {
  await cp(join(packagePath, "src"), join(snapshot, "src"), {
    recursive: true,
  });
  await cp(join(packagePath, "package.json"), join(snapshot, "package.json"));
  const modified =
    'import { createHash } from "node:crypto";\n' +
    original.slice(0, start) +
    original
      .slice(start, end)
      .replace(oldLine, 'const hasher = createHash("blake2b512");') +
    original.slice(end);
  await writeFile(join(snapshot, relativeUtility), modified);
  const upstream = await import(
    pathToFileURL(join(packagePath, relativeUtility)).href
  );
  const native = await import(
    pathToFileURL(join(snapshot, relativeUtility)).href
  );
  const curve = await curves.getCurveFromName("bn128", { singleThread: true });
  for (const power of [4, 8, 12]) {
    const expected = upstream.calculateFirstChallengeHash(curve, power);
    const actual = native.calculateFirstChallengeHash(curve, power);
    if (!Buffer.from(expected).equals(Buffer.from(actual)))
      throw new Error(
        `Native/upstream initial hash mismatch at power ${power}`,
      );
  }
  console.log(
    "Native BLAKE2b-512 initial-challenge self-tests match full upstream JS hashes at powers 4, 8, 12.",
  );
  console.log(
    `Upstream utility SHA-256: ${createHash("sha256").update(original).digest("hex")}`,
  );
  console.log(
    "Only calculateFirstChallengeHash's hasher provider is replaced. All other upstream verification code is unmodified.",
  );
  const { default: verify } = await import(
    pathToFileURL(join(snapshot, "src/powersoftau_verify.js")).href
  );
  const logger = {
    info: console.log,
    debug: () => {},
    error: console.error,
    warn: console.warn,
  };
  const startTime = performance.now();
  if (!(await verify(resolve(transcript), logger)))
    throw new Error("Public MPC verification failed");
  console.log(
    `Complete upstream Powers of Tau verification PASSED in ${Math.round((performance.now() - startTime) / 1000)} seconds (native initial hash only).`,
  );
} finally {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
  await rm(snapshot, { recursive: true });
}
